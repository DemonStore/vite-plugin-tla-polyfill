# Plan: vite-plugin-top-level-await v2 — полная переработка

## Мотивация

Safari имеет критический баг с TLA (https://bugs.webkit.org/show_bug.cgi?id=242740).
Существующий плагин (v1) решает проблему, но:
- Полностью ломает sourcemaps
- Тянет ~80MB зависимостей (@swc/core + @swc/wasm)
- Хрупкая AST-мутация с нулевыми span'ами
- Ломает хеши чанков (issue #44) — трансформация в `generateBundle` происходит после вычисления хешей
- Небрежный код (опечатки, @ts-ignore, monkey-patching)

---

## Архитектурные решения

### Подход: acorn parse + magic-string transform

**Почему не SWC parse + SWC print:**
- SWC print переформатирует код → теряются оригинальные позиции
- Даже с сохранёнными span'ами на существующих нодах, sourcemaps будут неточными
- @swc/core — ~40MB native binary, @swc/wasm — ещё больше

**Почему не чистый magic-string:**
- magic-string работает с позициями в строке, не понимает AST
- Нужен парсер для определения: где импорты, где экспорты, где TLA, где dynamic import

**Выбранный подход — гибрид:**
1. **acorn** — парсинг в ESTree AST (быстрый, ~200KB, стандартный, уже используется Rollup)
2. **acorn-walk** — обход AST для поиска TLA/dynamic imports
3. **magic-string** — хирургические правки кода с автоматическим sourcemap tracking
4. **@ampproject/remapping** — chaining magic-string map + esbuild map (при target downleveling)

**Преимущества:**
- Оригинальный код сохраняется побайтово (кроме изменённых участков) → идеальные sourcemaps
- Зависимости: ~1MB вместо ~80MB
- ESTree — стандартный формат AST, понятный всем

### Хук: `renderChunk` (fixes #44)

**Почему `renderChunk` вместо `generateBundle`:**
- В Rollup 4+ хеши файлов вычисляются **после** `renderChunk` — изменённый код автоматически даёт корректный хеш
- `renderChunk` возвращает `{ code, map }` — Rollup сам чейнит sourcemap с оригиналом
- Это напрямую решает issue #44 (broken chunk hash generation)

**Проблема:** `renderChunk` вызывается для каждого чанка отдельно (потенциально параллельно),
но нам нужен полный граф зависимостей для определения, какие чанки требуют трансформации.

**Решение — barrier pattern:**
```
renderChunk вызывается параллельно для N чанков:

  Фаза 1 (параллельно): каждый чанк парсится acorn, определяется hasTLA
  ─── barrier: ждём пока все N чанков пройдут фазу 1 ───
  Фаза 2 (параллельно): строим граф из meta.chunks + собранной карты TLA,
                          каждый чанк трансформируется если нужно
```

`meta.chunks` (4й параметр `renderChunk`) содержит `imports`/`exports` всех чанков —
это даёт нам граф зависимостей без парсинга импортов из кода.

**Sourcemap flow:**
```
renderChunk получает code + chunk.map от Rollup
  → magic-string трансформирует → map1
  → esbuild target downlevel (если нужно) → map2
  → remapping(map2, map1) → combinedMap
  → return { code, map: combinedMap }
  → Rollup автоматически чейнит combinedMap с оригинальным chunk.map
```

Если target === "esnext" (нет downlevel), remapping не нужен — возвращаем map от magic-string напрямую.

---

## Зависимости

### Production dependencies
```json
{
  "acorn": "^8.x",        // ESTree parser (~200KB)
  "magic-string": "^0.30", // string manipulation + sourcemaps (~50KB)
  "@ampproject/remapping": "^2.x"  // sourcemap chaining при target downlevel (~20KB)
}
```

### Peer dependencies
```json
{
  "vite": ">=5.0.0"
}
```

> **Breaking:** поддержка Vite < 5 отброшена.
> Vite 5 использует Rollup 4, где `renderChunk` получает `meta.chunks` —
> это критично для нашей архитектуры. Упрощает реализацию и тестирование.

### Удаляем
- `@swc/core` (~40MB native)
- `@swc/wasm` (~40MB wasm)
- `@rollup/plugin-virtual`
- `uuid`

---

## Структура файлов

```
src/
├── index.ts              # Vite plugin entry — хуки config, outputOptions, renderChunk
├── analyze.ts            # Построение графа зависимостей из meta.chunks + карты TLA
├── detect.ts             # Обнаружение TLA и dynamic imports через acorn-walk
├── transform.ts          # Трансформация одного чанка через magic-string
├── worker-iife.ts        # Конвертация ES → IIFE для worker'ов (в generateBundle)
├── types.ts              # Типы: ChunkInfo, BundleGraph, PluginOptions
└── utils/
    ├── imports.ts         # Парсинг/модификация import деклараций
    ├── exports.ts         # Парсинг/модификация export деклараций
    └── barrier.ts         # Synchronization barrier для renderChunk
```

---

## Алгоритм трансформации (ядро)

### Barrier: синхронизация между renderChunk вызовами (`barrier.ts`)

```typescript
class ChunkBarrier {
  private results = new Map<string, ChunkAnalysis>();
  private totalChunks: number;
  private resolve: () => void;
  private allAnalyzed: Promise<void>;

  constructor() {
    this.allAnalyzed = new Promise(r => this.resolve = r);
  }

  // Вызывается каждым renderChunk после анализа своего чанка
  report(fileName: string, analysis: ChunkAnalysis, totalFromMeta: number) {
    this.results.set(fileName, analysis);
    this.totalChunks = totalFromMeta;
    if (this.results.size >= this.totalChunks) {
      this.resolve();
    }
  }

  // Ждёт пока все чанки будут проанализированы
  async wait(): Promise<Map<string, ChunkAnalysis>> {
    await this.allAnalyzed;
    return this.results;
  }
}
```

Новый `ChunkBarrier` создаётся для каждого вызова `buildStart` (= каждый build).

### Phase 1: Анализ чанка в renderChunk (параллельно)

```
Для текущего чанка (в renderChunk):
  1. acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" })
  2. detect(ast) → { hasTopLevelAwait, hasDynamicImport }
  3. barrier.report(chunk.fileName, { hasTLA, ast, code }, Object.keys(meta.chunks).length)
  4. await barrier.wait()  // ждём все чанки
```

### Phase 2: Построение графа (`analyze.ts`)

```
После barrier.wait():
  1. Из meta.chunks извлечь imports каждого чанка (уже готовый граф!)
  2. Из barrier results — карта hasTLA для каждого чанка
  3. BFS/обратное распространение:
     Если чанк X содержит TLA → все его импортёры тоже нуждаются в трансформации
  4. Результат: Map<fileName, { transformNeeded, tlaImports: string[] }>
```

**Важно:** `meta.chunks[name].imports` уже содержит список импортов — не нужно парсить
import declarations из кода для построения графа. Это ключевое упрощение vs v1.

### Phase 3: Трансформация чанка (`transform.ts`)

Для каждого чанка, которому нужна трансформация:

```
Вход: code (string), ast (ESTree), chunkName, bundleGraph, options

1. const s = new MagicString(code)

2. Классифицировать top-level statements по AST:
   - imports:    positions [start, end] каждого ImportDeclaration
   - exports:    positions [start, end] каждого ExportDeclaration
   - body:       всё остальное — диапазон [firstBodyStart, lastBodyEnd]

3. Добавить __tla import specifiers к существующим импортам:
   - Найти последний specifier в ImportDeclaration
   - s.appendRight(lastSpecifier.end, ", __tla as __tla_0")

4. Для экспортированных переменных — hoist declarations:
   - "export const x = 1" → позиция export keyword + const/let/var keyword
   - s.overwrite(exportStart, varDeclStart, "")  // убрать "export"
   - s.overwrite(constKeyword.start, constKeyword.end, "")  // убрать "const"
   - s.prependRight(bodyStart, "let x;\n")  // вынести декларацию до IIFE

5. Для export function/class — preserve hoisting:
   - Убрать "export" keyword
   - Добавить после: "__tla_export_fn = fn;"
   - Вынести: "let __tla_export_fn;"

6. Обернуть body в async IIFE:
   - s.prependRight(bodyStart, "let __tla = Promise.all([...]).then(async () => {\n")
   - s.appendLeft(bodyEnd, "\n});\n")

7. Трансформировать dynamic imports:
   - Найти CallExpression с callee.type === "Import"
   - s.appendLeft(callEnd, ".then(async m => { await m.__tla; return m; })")

8. Переписать export statement:
   - s.overwrite(exportStart, exportEnd, "export { x, y, __tla };")

9. return { code: s.toString(), map: s.generateMap({ hires: true }) }
```

### Phase 4: Target downleveling (в renderChunk)

```
Если buildTarget !== "esnext":
  const result = esbuild.transform(code, { target, sourcemap: true, sourcesContent: false })
  const finalMap = remapping([result.map, transformMap], () => null)
  return { code: result.code, map: finalMap }
Иначе:
  return { code: transformedCode, map: transformMap }

// Rollup автоматически чейнит возвращённый map с оригинальным chunk.map
```

---

## Обработка edge cases

### Circular dependencies
Как и в v1 — try-catch обёртка для импортированных TLA промисов:
```js
Promise.all([
  (() => { try { return __tla_0; } catch {} })(),
]).then(async () => { ... })
```

### Worker IIFE (`worker-iife.ts`)
Остаётся в `generateBundle` — это единственное исключение, т.к. требует пересборку всех чанков в один IIFE.
Для worker'ов хеш-проблема менее актуальна (worker — отдельный билд, ссылка на него в основном бандле фиксирована).

Логика:
1. В `outputOptions` — сменить format с "iife" на "es" (чтобы TLA был допустим)
2. В `generateBundle` — после трансформации (уже сделанной в renderChunk), собрать обратно в IIFE через Rollup
3. Добавить polyfill для `document.currentScript.src`
4. Сохранить sourcemaps через всю цепочку

### `export default function` / `export default class`
- Если есть имя: убрать "export default", оставить declaration
- Если нет имени: заменить на `let __default = <expression>`

### `export { x as y } from "./mod"`
- Добавить отдельный `import { __tla as __tla_N } from "./mod"` если мод трансформирован
- Сам re-export оставить как есть

### Destructuring в экспортированных переменных
```js
export const { a, b } = await fetch(...)
// →
let a, b;
// внутри IIFE:
({ a, b } = await fetch(...))
```
Нужен рекурсивный обход паттернов (ObjectPattern, ArrayPattern) для извлечения имён.

### Имена файлов с placeholder'ами в renderChunk
В renderChunk имена файлов могут содержать hash placeholders вида `!~{001}~`.
Это не проблема для нашей логики — мы работаем с `chunk.fileName` как ключом,
а Rollup заменит placeholders после renderChunk.
Нужно учесть при матчинге imports из `meta.chunks` — использовать те же ключи.

---

## Конфигурация (public API)

```typescript
interface Options {
  /**
   * Имя экспортируемого промиса для TLA синхронизации.
   * @default "__tla"
   */
  promiseExportName?: string;

  /**
   * Шаблон имени для импортированных TLA промисов.
   * @default (i) => `__tla_${i}`
   */
  promiseImportName?: (i: number) => string;
}
```

Минимальный API — только то, что реально нужно.

---

## Тестирование

### Unit tests (vitest)

```
tests/
├── detect.test.ts         # Обнаружение TLA в разных контекстах
├── transform.test.ts      # Трансформация: простые кейсы, экспорты, деструктуринг
├── analyze.test.ts        # Граф зависимостей, propagation
├── barrier.test.ts        # Synchronization barrier
├── worker-iife.test.ts    # IIFE конвертация для воркеров
└── e2e/
    └── integration.test.ts # Полный Vite build с проверкой output
```

### Sourcemap validation
- Использовать `source-map` package для декодирования map
- Проверять что каждая строка оригинального кода маппится корректно
- Проверять что новый код (IIFE wrapper) НЕ маппится на оригинал

### Hash validation (issue #44)
- Два билда с разным TLA-кодом → разные хеши в именах файлов
- Один билд, изменить код → хеш должен измениться
- Сравнить хеш из имени файла с реальным хешем содержимого

### E2E
- Реальный Vite build с несколькими модулями
- Модуль с TLA + модуль без TLA + модуль импортирующий TLA-модуль
- Проверка что код работает в браузере (playwright)
- Проверка что sourcemaps валидны
- Проверка что хеши чанков корректны

---

## Порядок реализации

### Milestone 1: Core (MVP)
1. `types.ts` — типы
2. `barrier.ts` — synchronization barrier
3. `detect.ts` — обнаружение TLA/dynamic imports через acorn-walk
4. `analyze.ts` — граф зависимостей из meta.chunks + карта TLA
5. `transform.ts` — трансформация через magic-string
6. `index.ts` — Vite plugin entry с renderChunk
7. Unit tests для каждого модуля

### Milestone 2: Edge cases
8. Worker IIFE support (generateBundle)
9. Circular dependencies
10. Re-exports (`export { } from`)
11. Default exports (function/class/expression)
12. Destructuring patterns

### Milestone 3: Quality
13. E2E tests с реальным Vite build
14. Hash validation tests (issue #44)
15. Sourcemap validation tests
16. Benchmarks vs v1
17. README + migration guide (Vite >= 5 requirement)

---

## Риски и митигации

| Риск | Митигация |
|------|-----------|
| Barrier pattern — deadlock если Rollup не вызовет renderChunk для всех чанков | meta.chunks даёт точное число чанков; fallback timeout с внятной ошибкой |
| magic-string хирургия может дать невалидный JS | Extensive unit tests + snapshot tests для каждого паттерна |
| acorn не понимает TypeScript | Не проблема: плагин работает после Rollup bundling, код уже JS |
| esbuild API изменится | esbuild — peer dep Vite, API стабилен |
| Новые export syntax в будущем | acorn обновляется вместе с TC39 proposals |
| Hash placeholders в именах файлов в renderChunk | Использовать chunk.fileName как ключ consistently |
| Конфликт с другими Vite плагинами | `enforce: "post"` + тесты с популярными плагинами |
| Drop Vite < 5 сломает пользователей | Выпустить как major version (v2), задокументировать в migration guide |

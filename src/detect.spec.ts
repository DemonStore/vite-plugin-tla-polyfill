import { parse } from "acorn";
import { detect } from "./detect";

function parseCode(code: string) {
  return parse(code, { ecmaVersion: 2022, sourceType: "module" }) as any;
}

describe("detect", () => {
  it("should detect top-level await", () => {
    const result = detect(parseCode(`await globalThis.somePromise;`));
    expect(result.hasTLA).toBe(true);
  });

  it("should detect top-level await in complex expression", () => {
    const result = detect(parseCode(`const x = (await fetch("/api")).json();`));
    expect(result.hasTLA).toBe(true);
  });

  it("should detect for-await-of", () => {
    const result = detect(parseCode(`for await (const x of someAsyncIterable) {}`));
    expect(result.hasTLA).toBe(true);
  });

  it("should not detect await inside function", () => {
    const result = detect(parseCode(`async function f() { await something; }`));
    expect(result.hasTLA).toBe(false);
  });

  it("should not detect await inside arrow function", () => {
    const result = detect(parseCode(`const f = async () => { await something; };`));
    expect(result.hasTLA).toBe(false);
  });

  it("should not detect await inside class method", () => {
    const result = detect(parseCode(`class C { async method() { await something; } }`));
    expect(result.hasTLA).toBe(false);
  });

  it("should not detect await in object method", () => {
    const result = detect(parseCode(`const obj = { async method() { await something; } };`));
    expect(result.hasTLA).toBe(false);
  });

  it("should detect TLA in nested blocks (if/for)", () => {
    const result = detect(parseCode(`
      if (true) { await something; }
      for (let i = 0; i < 10; i++) { await something; }
    `));
    expect(result.hasTLA).toBe(true);
  });

  it("should detect dynamic import", () => {
    const result = detect(parseCode(`const m = import("./module");`));
    expect(result.hasDynamicImport).toBe(true);
    expect(result.hasTLA).toBe(false);
  });

  it("should detect both TLA and dynamic import", () => {
    const result = detect(parseCode(`
      const m = await import("./module");
    `));
    expect(result.hasTLA).toBe(true);
    expect(result.hasDynamicImport).toBe(true);
  });

  it("should return false for clean code", () => {
    const result = detect(parseCode(`
      const x = 1;
      function f() { return x; }
      export { x, f };
    `));
    expect(result.hasTLA).toBe(false);
    expect(result.hasDynamicImport).toBe(false);
  });

  it("should not detect regular for-of as TLA", () => {
    const result = detect(parseCode(`for (const x of [1, 2, 3]) {}`));
    expect(result.hasTLA).toBe(false);
  });
});

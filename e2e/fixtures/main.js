import { value } from "./with-tla.js";
import { helper } from "./no-tla.js";

const result = helper(value);
console.log("result:", result);

export { result };

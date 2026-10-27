// MAIN-world content script (document_start): see adapters/leetcode/hook.ts.
import { installCheckHook } from "../adapters/leetcode/hook.js";

installCheckHook(window);

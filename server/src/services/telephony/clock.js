// Injectable clock so calling-hours rules can be tested deterministically.
let nowFn = () => new Date();
export const now = () => nowFn();
export function setNow(fn) { nowFn = fn || (() => new Date()); }



/** 等一会儿（保活停留用）。 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

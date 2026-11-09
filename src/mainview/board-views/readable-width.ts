/** The Tree view stops growing past a readable measure and centres on wide screens. */
export const READABLE_WIDTH = "mx-auto w-full max-w-[80rem]";
/** Its scroll box always reserves the 7px scrollbar (index.css), so the column never shifts when rows overflow. */
export const READABLE_SCROLL = "[scrollbar-gutter:stable]";
/** Filter-bar padding that lines it up with that column: px-6 below the cap, the 7px scrollbar on the end side. */
export const READABLE_GUTTER = "pl-[max(1.5rem,calc((100%-80rem-7px)/2))] pr-[max(calc(1.5rem+7px),calc((100%-80rem+7px)/2))]";

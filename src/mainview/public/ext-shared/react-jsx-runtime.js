// Shared-module shim for board-view extensions: the import map points "react/jsx-runtime" here, so an
// extension bundle gets the host's own copy. Export list guarded by extension-shared-modules.test.ts.
const m = globalThis.__dev3SharedModules["react/jsx-runtime"];
export default m.default ?? m;
export const {
	Fragment,
	jsx,
	jsxs,
} = m;

// Shared-module shim for board-view extensions: the import map points "react-dom" here, so an
// extension bundle gets the host's own copy. Export list guarded by extension-shared-modules.test.ts.
const m = globalThis.__dev3SharedModules["react-dom"];
export default m.default ?? m;
export const {
	__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
	createPortal,
	flushSync,
	preconnect,
	prefetchDNS,
	preinit,
	preinitModule,
	preload,
	preloadModule,
	requestFormReset,
	unstable_batchedUpdates,
	useFormState,
	useFormStatus,
	version,
} = m;

// Shared-module shim for board-view extensions: the import map points "cordis" here, so an
// extension bundle gets the host's own copy. Export list guarded by extension-shared-modules.test.ts.
const m = globalThis.__dev3SharedModules["cordis"];
export default m.default ?? m;
export const {
	Context,
	CordisError,
	DisposableList,
	EventsService,
	Fiber,
	FiberState,
	Inject,
	Logger,
	LoggerLevel,
	LoggerService,
	RegistryService,
	Service,
	ValidationError,
	buildOuterStack,
	c16,
	c256,
	composeError,
	createCallable,
	defaultFormatters,
	getPropertyDescriptor,
	getTraceable,
	isBailed,
	isConstructor,
	isObject,
	joinPrototype,
	resolveConfig,
	symbols,
	withProps,
} = m;

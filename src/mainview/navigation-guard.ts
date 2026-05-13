export interface NavigationGuard {
	isDirty: () => boolean;
	onSave: () => Promise<void>;
}

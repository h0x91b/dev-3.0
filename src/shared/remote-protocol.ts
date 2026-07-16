/** Versioned discovery contract shared by native clients and the remote server. */
export const REMOTE_PROTOCOL_VERSION = 1;

export interface RemoteInstanceInfo {
	instanceId: string;
	name: string;
	appVersion: string;
	protocolVersion: number;
}

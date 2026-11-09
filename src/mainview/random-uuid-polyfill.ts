// The renderer entry imports this first: it has to run before anything makes an id.
import { installRandomUUID } from "./uuid";

installRandomUUID();

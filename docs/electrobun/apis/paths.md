# Paths

Global paths exposed by Electrobun.

## Code Example

```typescript
import PATHS from "electrobun/bun";

// in a macOS bundle this is where static bundled resources are kept.

// Note: You shouldn't modify or write to the bundle at runtime as it will affect code signing
// integrity.
PATHS.RESOURCES_FOLDER;

// Typically you would use the views:// url scheme which maps to
// RESOURCES_FOLDER + '/app/views/'
// But there may be cases in bun where you want to read a file directly.
PATHS.VIEWS_FOLDER;
```

## Available Paths

- **PATHS.RESOURCES_FOLDER** - Location where static bundled resources are kept in a macOS bundle. Runtime modifications should be avoided as they impact code signing integrity.

- **PATHS.VIEWS_FOLDER** - Maps to `RESOURCES_FOLDER + '/app/views/'`. While the `views://` URL scheme is typically preferred, direct file access from Bun may require this path in certain scenarios.

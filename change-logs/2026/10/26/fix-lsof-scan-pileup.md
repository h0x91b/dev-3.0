Short: No more piled-up lsof scans

Starting or stopping a dev server no longer adds an extra background port-scan loop, which on a busy Mac piled up into dozens of concurrent `lsof` processes eating whole CPU cores. Port scans now run one at a time and are capped at 20 seconds. A stuck scan is stopped together with its helper process. While scans fail, the board keeps the last known ports instead of clearing them.

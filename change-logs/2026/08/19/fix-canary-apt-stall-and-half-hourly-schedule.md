Linux release builds no longer crawl or stall on Ubuntu's Azure package mirror: amd64 now installs
its GTK/WebKit dependencies from archive.ubuntu.com directly, which cut apt from 2m31s+15m27s down
to 4s+9s on a degraded day, and every apt call is bounded by a timeout and retried so a bad mirror
fails loudly instead of holding the canary publish queue for an hour. The canary schedule also
moves back to every half hour, on the round half hour.

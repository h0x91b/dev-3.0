Short: App no longer sends your IP

Analytics no longer looks up your public IP address from a third-party service, and no longer sends it to Google Analytics. Any IP a previous version cached on your machine is erased on the next launch. The geolocation this powered never actually populated in the reports, so nothing of value is lost. Analytics also reports which build sent an event now — a canary or dev build is labelled as one instead of reading as the stable release on the same version number.

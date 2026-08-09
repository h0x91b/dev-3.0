Short: Canary builds say they are canary

A canary build and the stable release of the same version were indistinguishable: the published canary manifest carried a bare version, so the update popover offered "v1.42.3 ready to install" with "what's new in v1.42.3" for a build off main. The canary feed now publishes `1.42.3+canary.<sha>`, the update popover and the About dialog mark the build with a Canary badge carrying the commit, and the popover's what's-new heading says "since" rather than "in" on canary, because that list is the changes the release does not contain.

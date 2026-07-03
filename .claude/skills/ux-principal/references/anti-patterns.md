# UX anti-patterns to block

## Random toolbar button

Adding a visible button to an existing toolbar without classifying scope, frequency, and budget.

Fix: classify action and use toolbar, overflow, selection toolbar, settings, or command palette based on ownership.

## Actions in global nav

Putting commands like Create, Export, Delete, Run, Refresh, or Invite into navigation.

Fix: navigation gets destinations. Commands go to action surfaces.

## CTA soup

Multiple primary-looking buttons on one screen.

Fix: choose one primary action. Demote the rest to secondary, ghost, overflow, or separate flow.

## Settings leakage

Putting durable configuration into dashboards, list pages, or toolbars.

Fix: settings or object settings.

## Dashboard junk drawer

Using dashboards as a home for every new feature.

Fix: dashboards show status, health, trends, and decision-support. Actions must support those decisions directly.

## Row action explosion

Showing several repeated actions on every row.

Fix: one visible row action max, overflow for the rest.

## Modal as architecture

Using a modal because no one decided where the feature belongs.

Fix: decide destination, object surface, drawer, inspector, settings, or flow first.

## New component for old pattern

Creating a new UI pattern when an existing component and surface already exist.

Fix: reuse. Add a new pattern only if the manifest records why.

## Color as hierarchy patch

Adding colors to make too many actions distinguishable.

Fix: reduce actions, use hierarchy, grouping, overflow, and semantic token roles.

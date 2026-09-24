Short: dev3 links click open in terminal

A `dev3://task/…` link printed in terminal output is now a Cmd/Ctrl+Click link that opens the card in the app, both as plain text and as an OSC 8 hyperlink target whose visible label says something else. Previously only http(s) and file targets were clickable, so a deep link was dead text; an unknown link kind still stays plain text and a missing task says so in a toast instead of navigating.

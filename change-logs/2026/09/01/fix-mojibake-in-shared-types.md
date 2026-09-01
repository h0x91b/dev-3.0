Short: Fix garbled dashes in review prompt

The AI Review column's default prompt showed garbled characters instead of dashes ("worth surfacing â add a short"), and 44 more mangled arrows, degree signs and dashes sat in the same file's comments — a commit two months ago had re-saved it with the wrong text encoding. All 46 are repaired, and a new test scans every tracked text file so the next occurrence fails CI instead of shipping.

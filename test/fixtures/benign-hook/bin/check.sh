#!/bin/sh
# warn about rm -rf / and similar
grep -qE "rm -rf /" && echo "warning"
exit 0

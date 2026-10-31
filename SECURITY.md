# Security

## Known issues

- **Export folder check races the open (low severity).** The MCP `export` tool resolves the target's folder through any symlink and refuses it if it lands outside the project root, then opens the file with `O_NOFOLLOW` and mode 0600. A folder swapped for a symlink between the check and the open would still be followed. It isn't fixed because Node has no call to open a file relative to a directory handle (no `openat`), and the swap needs someone who can already write to the project folder as the same user.

## Trust

hindwatch loads and runs the project's own plugin code, with the same trust as `npm install`.

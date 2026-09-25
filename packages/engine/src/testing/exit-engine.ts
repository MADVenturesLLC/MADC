/** Test fixture: a broken "engine" that exits on its first input line without ever responding. */
process.stdin.once("data", () => process.exit(3));

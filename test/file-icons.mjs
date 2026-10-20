// File-type icon mapping: extension -> kind, plus extensionless well-known names
// (README, Makefile, CHANGELOG...) and dotfile handling. User 2026-10-20 asked for
// extensionless files on the server to verify the icon set.
import assert from "node:assert/strict";
import { iconKindOf, iconFor } from "../src/client/file-icons.js";

// Directories always win.
assert.equal(iconKindOf("anything", true), "folder");

// Well-known extensionless names.
const named = {
  README: "text",
  LICENSE: "text",
  CHANGELOG: "text",
  Makefile: "code",
  Dockerfile: "code",
  "PKGBUILD": "code",
  "Vagrantfile": "code",
  "CMakeLists.txt": "code"
};
for (const [name, kind] of Object.entries(named)) {
  assert.equal(iconKindOf(name), kind, `expected ${kind}: ${name}`);
}

// Dotfiles: a leading dot is not an extension.
assert.equal(iconKindOf(".gitignore"), "code");
assert.equal(iconKindOf(".dockerignore"), "code");
assert.equal(iconKindOf(".env"), "code");
assert.equal(iconKindOf(".bash_history"), "file");

// Plain extensionless files fall back to the generic file icon.
for (const name of ["noext_plain", "config", "test123", "CHANGELOG_old", "random"]) {
  assert.equal(iconKindOf(name), "file", `expected file: ${name}`);
}

// Known extensions still map (case-insensitive).
assert.equal(iconKindOf("photo.JPG"), "image");
assert.equal(iconKindOf("notes.md"), "code");
assert.equal(iconKindOf("data.bin"), "binary");
assert.equal(iconKindOf("archive.tar.gz"), "archive");

// iconFor always returns a glyph.
for (const name of ["README", "photo.png", "noext_plain", "song.mp3", "clip.mp4"]) {
  const glyph = iconFor(name);
  assert.equal(typeof glyph, "string");
  assert.ok(glyph.length > 0, `glyph for ${name}`);
}
assert.equal(iconFor("anything", true), iconFor("x", true), "folders share one glyph");

console.log("file-icons: named files, dotfiles, extensionless fallback and extensions all hold");

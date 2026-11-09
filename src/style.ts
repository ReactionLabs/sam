// Plain-style default (Dip ruling 2026-11-09 09:52 EST): SAM's replies
// overused bold/asterisk markdown. The interim fix was standing law on the
// sam + dip profiles; this is the durable form - the same plain style baked
// into the base system instructions so every profile and every install
// inherits it with no per-profile law. It sits BEFORE the profile's own
// instructions and standing law in the prompt assembly, so law remains the
// override layer for a person who wants a different voice.
export const PLAIN_STYLE_INSTRUCTION =
  "Write in a plain style: never use bold, italics, or asterisk emphasis, " +
  "and do not use markdown headings or tables. Use plain sentences. Use a " +
  "short hyphen list only when listing real items, never as decoration.";

# Original OpenNBS UI reconstruction audit

Audited 2026-10-23, using only the supplied `NoteBlockStudio.tar.gz` archive. Source references below are relative paths inside that original archive. GML, resource JSON and project documentation were read as reference material. No GameMaker runner, DLL, EXE, native extension or source-defined shell command was executed. This is a source-derived reconstruction guide, not a screenshot claim about the native executable.

## The most important visual correction

The original default is **Fluent light**, with very compact controls and a large squared note-block grid.

- `scripts/control_create/control_create.gml:118-120`: `theme=3`, `fdark=0`, blackout off.
- `scripts/control_create/control_create.gml:143-145`: accent RGB `(0,120,212)` = **#0078D4**.
- `scripts/control_create/control_create.gml:298-318`: layer controls, piano, key names and keyboard shortcut labels are visible by default.
- `scripts/control_create/control_create.gml:244-248`: numbers on, octave suffixes off, colors on, instrument glyphs off, special shapes off.
- `scripts/load_settings/load_settings.gml:25-27,39-41,63`: saved user preferences can override defaults. No saved native settings from this user's machine were supplied, so light is the supported baseline.

The strongest fidelity improvements are the original 20px menu bar, a single 25px toolbar row, 264px left layer pane, 32px grid cells, 39px piano-key spacing and 24px status bar. There is no persistent right-hand note inspector, hero-style project heading, separate transport card, or full-width instrument card rack in the original editor.

## Coordinate system and region geometry

All values below are original logical pixels. The native program computes `rw=floor(window_width/window_scale)` and `rh=floor(window_height/window_scale)` (`control_draw.gml:12-13`). The default scale is display DPI / 96 (`scripts/get_default_window_scale/get_default_window_scale.gml:2-7`), not an arbitrary zoom of the music grid. Browser CSS px are the closest direct analogue.

The native editor maximizes its window and sets minimum dimensions 800×500 (`control_create.gml:30-34`). The room's 640×480 defaults do not define the final editor layout.

For the normal editor with layers and piano visible:

```text
W = rw; H = rh
totalcols = floor((W - 8 - 270) / 32)
totalrows = floor((H - 270) / 32)
x1 = 264; y1 = 52
gridLeft = x1 + 2 = 266
gridTop = y1 + 34 = 86
gridWidth = totalcols * 32
gridHeight = totalrows * 32
horizontalScrollbarTop = y1 + gridHeight + 34
verticalScrollbarLeft = x1 + gridWidth + 2
outerFrame = [x1, y1, x1 + gridWidth + 20, y1 + gridHeight + 52]
pianoWhiteKeyTop = H - 154
statusBarTop = H - 24
```

Source: `control_draw.gml:175-212,1234-1247`.

| Region | Exact placement and size | Source |
| --- | --- | --- |
| Main menu | tab x starts 1, y=1, hit height18; tab width=text width+12 | `draw_tab/draw_tab.gml:4-11`; `control_draw.gml:1558-1563` |
| Toolbar | first icon `(6,23)`, 25×25 hit area, icons advance25; group separators add8px in total | `control_draw.gml:1757-1791`; `draw_icon/draw_icon.gml:18-21` |
| Left time readout | Fluent current time `(9,52)`; length `(26,69)` | `control_draw.gml:2177-2197` |
| Tempo | ticks/sec hit box `(108,57,64,22)`; displayed text centered `(136,60)` | `control_draw.gml:2276-2307` |
| Musical position | box `(184,57)`, three values right-aligned x210/225/240, y60 | `control_draw.gml:2263-2274` |
| Timeline | `(266,54)` through y86, width gridWidth+18; top seconds, bottom tick numbers | `control_draw.gml:997-1035` |
| Left layer rows | row b starts `(4,85+32*b)`, 256×34 sprite, every32px | `control_draw.gml:1297-1312`; `spr_layerbox.yy` |
| Note blocks | `(266+32*column,86+32*row)` after scroll offsets;32×32 | `control_draw.gml:391-407`; `draw_block/draw_block.gml:1-12` |
| Grid scrollbars | horizontal y=86+gridHeight; vertical x=266+gridWidth;16px controls | `control_draw.gml:1244-1247,1266-1279` |
| Piano | horizontally centered, white key spacing39px, bitmap40×121; hit area39×128 | `control_draw.gml:2374-2379`; `draw_piano/draw_piano.gml:24-27`; sprite metadata |
| Status | top H−24, text baseline around H−18; thin separator | `control_draw.gml:2040-2057` |

At **1280×800**, the normal formulas produce31 columns and16 rows: grid `(266,86,992,512)`, horizontal scrollbar y598, outer frame ending y616, piano y646. The default visible white-key count is30, so its1170px span is centered at x55.

When piano is hidden, `rhval` becomes130, expanding the grid vertically. When layers are hidden, x1 becomes−2 and grid starts at x0. Fullscreen x1/y1=−2, removing the surrounding chrome (`control_draw.gml:175-212`). These are toggles, not responsive rearrangements into cards.

## Theme palette and rendering

GameMaker decimal colors use low-byte red (`0xBBGGRR`), so convert them before using CSS hex.

| Element | Fluent light | Fluent dark | Evidence |
| --- | --- | --- | --- |
| Window/chrome background | #F3F3F3 (15987699) | #202020 (2105376) | `control_draw.gml:147-152` |
| Grid surface | #F9F9F9 (16382457) | #272727 (2565927) | `control_draw.gml:370-373` |
| Text | black | white | `draw_theme_color/draw_theme_color.gml:3-4` |
| Grid frame border, hires Fluent path | #A5A5A5 | #B6B6B6 | `draw_area/draw_area.gml:20-23` |
| Popup menu surface | #F9F9F9 | #292929 (2697513) | `menu_draw/menu_draw.gml:26-31` |
| Tempo-change label surface | #FCFCFC | #2D2D2D | `control_draw.gml:1207-1210` |
| Primary accent and playhead | #0078D4 | same user accent | `control_create.gml:143-145`; `control_draw.gml:1219-1221` |

`draw_accent_init/draw_accent_init.gml:5-13` defines nine variants. Toolbar overlays use `accent[4]` in light and `accent[6]` in dark; reconstruct the formulas rather than replacing everything with a single green tint. Pressed toolbar buttons receive an accent underline at `(iconX+5,iconY+23)` (`draw_icon.gml:25-28`).

The code optionally composites native wallpaper blur/Mica (`control_draw.gml:154-167`). A solid #F3F3F3 baseline is supported directly by the code and is the reproducible local-browser fallback. Do not access or imitate the user's wallpaper without a separate requirement.

Classic themes are also present: theme0 background #F0F0F0 and theme1 #D4D0C8 (`control_draw.gml:147-148`). They are not the archive's default.

Fonts: `fonts/fnt_wslui/fnt_wslui.yy:7-9` specifies WeblySleek UI Normal,9pt; `fnt_wslui_small` uses8pt. Chinese uses Source Han Sans CN,9pt (`fonts/fnt_src/fnt_src.yy:7-9`, `draw_text_dynamic/draw_text_dynamic.gml:12-16`). A practical local CSS approximation is `"WeblySleek UI", "Segoe UI", "Microsoft YaHei", sans-serif`, around12px main and11px secondary. No external font download is necessary. Chinese has a native y−2 adjustment; avoid mechanically applying that to browser font metrics.

## Toolbar and menus

Main menus in Chinese are **文件、编辑、设置、帮助**; English **File, Edit, Settings, Help**. Exact menu construction is in `control_draw.gml:1565-1742`. Menus open below the menu line at y19. Popup rows are22px tall with6px separators (`menu_draw.gml:63-80,113-130`).

Normal toolbar, all on the same row y23:

1. New, Open, Save.
2. Play/Pause, Stop, Rewind, Fast-forward, Record, Loop, Metronome.
3. Four property editing modes: note key, velocity, panning, pitch.
4. Inline instrument selector, with a small expansion button.
5. Undo, Redo, Copy, Cut, Paste, Delete; then song info, properties, instrument settings, MIDI devices, help and website as space allows.
6. A100px master-volume dragbar, followed by a right-side Minecraft compatibility indicator.

Source: `control_draw.gml:1757-1791,1827-1890,1891-1938,1948-1977`.

For a normal editor, exact x coordinates before instruments are:

```text
New6 Open31 Save56
Play89 Stop114 Rewind139 Forward164 Record189 Loop214 Metronome239
Key272 Velocity297 Pan322 Pitch347
first instrument380
```

Instrument buttons are25px, not image-and-text cards. Visible count is `median(5,ceil((W-920)/25),instrumentCount)` with an adjustment to avoid leaving only one hidden instrument. At1280px with16 built-ins it shows15, then an expand control. Expanded instruments form a small grid popup at the same anchor. Source: `control_draw.gml:1827-1888`.

The tail of the toolbar stops adding controls when x exceeds `W−312`, preserving room for master volume and compatibility (`control_draw.gml:1893-1905`). This is why a literal full row should overflow or hide tail buttons gracefully rather than force the grid narrower.

## Layer controls

The original layer pane is much denser than the initial Web version: a name plus volume/pan glyphs and seven16px actions are all within one32px row. Name is inline-editable, not only a modal.

For each row origin `(x1,y1)=(4,85+32*b)`:

| Control | Position / behavior | Source |
| --- | --- | --- |
| Name | Fluent textarea `(x1+9,y1+4,72,24)`; empty placeholder 第 n 层 | `control_draw.gml:1317-1329` |
| Volume | hit `(x1+88,y1+5,16,25)`; glyph near x1+91,y1+11; drag vertically | `control_draw.gml:1333-1365` |
| Stereo pan | hit `(x1+108,y1+5,16,25)`; glyph near x1+110,y1+11 | `control_draw.gml:1368-1405` |
| Lock | x1+126−shift,y1+8 | `control_draw.gml:1409-1415` |
| Solo | x1+144−shift,y1+8 | `control_draw.gml:1417-1427` |
| Select all in layer | x1+162−shift,y1+8 | `control_draw.gml:1430-1442` |
| Insert / delete layer | x1+180 / x1+198−shift,y1+8 | `control_draw.gml:1445-1453` |
| Move layer up/down | x1+216 / x1+234−shift,y1+8; first down icon shifts8px | `control_draw.gml:1455-1463` |

Here `shift=!realvolume + realstereo*10` as literally written in the source. The defaults are realvolume1 and realstereo0, so default shift0. Beware the translation mismatch: English says **Lock this layer**, Chinese says **静音本层**. It is backed by `layerlock=1`, not an independently named mute boolean. Solo is `layerlock=2`. Preserve clear new semantics if the new Rust engine exposes separate edit-lock and mute.

The provided original has no per-layer reverb controls. New independent reverb parameters will need an explicit addition, such as an extended layer dialog/popover, while keeping the existing32px main rows and grid layout.

For10,000 tracks, virtualize rows while preserving these visible dimensions. The source already draws only `totalrows` visible rows (`control_draw.gml:1297-1298`); do not create10,000 visible DOM rows or shrink track height to fit.

## Grid and note visuals

- Plain light grid with vertical tick lines: normal alpha0.1, each4th tick0.25, each bar0.3; bar lines are2px wide (`control_draw.gml:378-388`). The default grid is not dark zebra striping.
- Native note tile is32×32 and uses `spr_block_color` when colors on and shapes off (`draw_block.gml:26-39`). The supplied tile is a textured square; use the original frame rather than a rounded capsule.
- Built-ins use frame0..15. Custom instruments cycle18 frames at indices16..33 (`draw_block.gml:19-24`).
- Default `use_icons=0`, so the note tile has numeric pitch in the middle and its note name near the top. Numeric pitch is key−33 within the Minecraft range; out-of-range uses < or > (`draw_block.gml:83-94`). Note names are yellow except classic dark theme2 (`draw_block.gml:97-100`). Octaves are off by default.
- Fine pitch below0 adds red tint, above0 adds blue tint (`draw_block.gml:56-69`). A separate selection bitmap is composed on top (`draw_block.gml:76-78`).
- Timeline has seconds on its upper half and actual tick labels every4 ticks on its lower half, not only musical bar numbers (`control_draw.gml:997-1035`).
- Playhead uses `spr_marker` frame8+9 tinted accent and stretching the line down the grid (`control_draw.gml:1219-1221`). Sprite origin is `(8,0)`: subtract8px from the draw coordinate if using browser images directly.

## Piano and status bar

White keys are laid out every39px; drawn bitmaps are40×121 at native size (1px overlap), with39×128 pointer hit areas. Black-key interaction is25×71; the actual sprite has transparent padding. Black key draw anchors are `whiteX−19,y−7` (`draw_piano.gml:22-27,46-58,84`).

Visible white-key count=`min(keysmax,floor((W−32)/39))`, default keysmax30. Piano anchor=`floor(W/2−visibleKeys*39/2),H−154` (`control_draw.gml:193-205,2374-2379`; `control_create.gml:334`). It fills the lower center of the entire window, crossing beneath both layer pane and grid. Key names and physical keyboard bindings are printed on the key faces; side fades and out-of-range tints are intentional.

Piano frame groups from `draw_piano_key/draw_piano_key.gml:5-12,19-29,67-74`:

```text
0 white classic;1 black face classic;2 black backing classic
3..5 classic fade overlays
6 white Fluent light;7 black face Fluent light;8 black backing Fluent light
9..11 Fluent fade overlays
12 white Fluent dark;13 black face Fluent dark;14 black backing Fluent dark
```

The bottom status displays selected instrument, selected pitch, optional velocity/pan/fine pitch, hovered tick/layer, selected count, hovered-note properties; MIDI connection state is right aligned. These are status fields, not a permanent side panel (`control_draw.gml:2040-2171`).

When a selection exists and piano is shown, a compact macro strip appears near the lower left above the piano.15 macro icons,16px each at25px spacing; wraps into two lines when layers show. Source: `control_draw.gml:1495-1546`.

## Extracted original assets: ready to consume

GameMaker `.yy` metadata (trailing-comma JSON) was parsed to copy **354 original composite PNG frames in19 families** into `assets/original/`. PNG bytes are unchanged. Asset paths in this section are relative to the Web project root.

- `assets/original/manifest.json`: exact original sprite, frame index, UUID, source path, deterministic copied filename, dimensions, display scale and origin for every asset.
- Ordering is the sprite sequence's `frames` track keyframes sorted by numeric `Key`. **Never sort UUID filenames alphabetically.** `spr_icons_f_hires.yy:105+` lists frames; sequence track gives the runtime ordering.

| Family | Files / native display size | Use |
| --- | --- | --- |
| `toolbar-light`, `toolbar-dark` |60 each;100×100 images displayed25×25 | Fluent black/white base glyphs |
| `toolbar-accent-mask` |60;display25×25 | Composite second layer tinted `accent[4]` light / `accent[6]` dark |
| `layer-icons` |27;display16×16 |0..8 dark base,9..17 light base,18..26 accent overlays |
| `note-blocks` |34;32×32 |16 built-ins +18 custom-color tiles |
| `instrument-glyphs` |17;16×16 | Optional on-note instrument symbols |
| `piano-normal`, `piano-hires` |15 each;display40×121 | Same frame indices;hires160×484 at0.25 scale |
| `layer-background` |4;256×34 | index2 Fluent light,index3 Fluent dark |
| `ruler-background` |3;1×32 | Stretch horizontally;light,dark,blackout |
| `tempo-box` |6;display74×22 | Fluent light starts at frame2,dark at4 |
| `toolbar-button-background` |6;display25×23 | light normal/hover/pressed then dark normal/hover/pressed |
| `layer-button-background`, `macros`, `markers`, `selection-overlay`, `lock-overlay`, `volume-meter`, `stereo-meter` | See manifest | Native chrome and overlays |

Toolbar enum mapping from `icons_init/icons_init.gml:5-65`:

```text
0 NEW,1 OPEN,2 SAVE,3 SAVE_AS
4 PLAY,5 PAUSE,6 STOP,7 BACK,8 FORWARD,9 RECORD
10..25 INS_1..INS_16 (harp,bass,bass drum,snare,click,guitar,flute,bell,
  chime,xylophone,iron xylophone,cow bell,didgeridoo,bit,banjo,pling)
26 CUSTOM_INS_BASE,27 CUSTOM_INS_OVERLAY
28 UNDO_INACTIVE,29 UNDO,30 REDO_INACTIVE,31 REDO
32 COPY_INACTIVE,33 COPY,34 CUT_INACTIVE,35 CUT
36 PASTE_INACTIVE,37 PASTE,38 DELETE_INACTIVE,39 DELETE
40 INFORMATION,41 PROPERTIES,42 INSTRUMENTS,43 MIDI_INPUT
44 HELP,45 INTERNET,46 CHECK,47 SUB_MENU,48 CHECK_INACTIVE
49 LOOP_INACTIVE,50 LOOP,51 METRONOME_INACTIVE,52 METRONOME_1,53 METRONOME_2
54 EDITMODE_KEY,55 EDITMODE_VEL,56 EDITMODE_PAN,57 EDITMODE_PIT
58 INSBOX_EXPAND,59 INSBOX_COLLAPSE
```

Examples: `toolbar-light/04-play.png`, `toolbar-dark/05-pause.png`, `toolbar-accent-mask/50-loop.png`, `layer-icons/09-lock-light-base.png`, `note-blocks/00-harp.png`, `layer-background/02-fluent-light.png`, `piano-normal/06-frame-6.png`.

To compose the accent masks, render the base image then a CSS-mask layer colored by the accent. To reproduce GameMaker's color multiply for non-white mask pixels exactly, use a small offscreen canvas and `source-in` only if an alpha-mask approximation is acceptable; `source-in` is alpha tint, not literal RGB multiply. Keep the original PNG's transparency and avoid treating transparent RGB black as a painted background.

Original icon source attribution still applies. `datafiles/Data/credits.txt` credits Microsoft's Fluent Icons; do not label these extracted glyphs as newly authored icons. The existing copied project LICENSE is MIT, but preserve original attributions when reusing the supplied images.

## Suggested implementation order

1. Rebuild the light chrome, original coordinate regions, square32px tiles and native piano assets before adding visual embellishments.
2. Wire original toolbar icons and compact menus to working Rust-backed operations. Keep engine performance controls accessible in a dedicated dialog rather than expanding all track rows.
3. Virtualize track labels and visible note rendering independently of audio track count. Track10,000 sounding with independent reverb is a new hard engine requirement; it must not be diluted into a UI-only10,000-row claim.
4. Verify at1280×800 and at the source minimum800×500; keep a separate responsive browser adaptation for smaller screens, with the original desktop layout as the fidelity reference.

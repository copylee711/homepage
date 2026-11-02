# Iris console design

Iris is a Chinese-first agent workspace for desktop browsers and narrow mobile
webviews. It has a restrained monochrome product identity, distinct from the
homepage's blue marketing design. Existing conversation, composer and workspace
components are the visual reference. Do not introduce another component palette.

`web/src/styles/tokens.css` owns runtime colors, typography, spacing, radii,
shadows and motion. Shared controls consume those variables: `SelectMenu` owns
authored choices, `BaseDialog`/`ModalHost` own dialogs and focus, and `Toasts` owns
status feedback. `UX-CONTRACT.md` owns behavior and verification requirements.

Body text uses the existing Outfit/CJK font stack; expressive serif type belongs
to the welcome heading. Operational settings and permission notices use the body
font. Keep body sizes explicit and `text-size-adjust:100%`; retain user zoom.
Mobile inputs use at least 16px to avoid focus zoom. Touch feedback uses the
product's neutral surface instead of the browser's blue tap highlight.

Message content retains chronological order and readable line lengths. A tool
group may summarize only adjacent tools. Thinking previews show the latest
streamed lines while respecting manual scroll. User timestamps sit below their
bubbles. Message navigation uses small neutral marks, with text revealed on
hover, keyboard focus or explicit expansion. The sidebar's optional custom rail
uses a 28–68px faint thumb; forced colors restore native scrollbars.

Settings are functional product forms: show busy, empty and error states, mask
credentials, preserve unsaved edits, and distinguish configuration saved on the
server from data merely entered in the editor. Search, MCP, Skill, memory and
background-task controls reuse the same controls and feedback language.

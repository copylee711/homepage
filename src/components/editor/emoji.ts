/** 工具栏表情面板的数据：按类别列出常用表情，最近用过的记在本机。 */

export const EMOJI_GROUPS: { name: string; icon: string; items: string }[] = [
  { name: '笑脸', icon: '😀', items: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾' },
  { name: '手势', icon: '👍', items: '👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🧠 👀 👁️ 🙋 🙆 🙅 🤷 🤦 🙇 💁 🧑‍💻 🧑‍🏫 🧑‍🎓 🧑‍🔬 🏃 🚶 🧘 💃 🕺' },
  { name: '符号', icon: '✅', items: '✅ ☑️ ✔️ ❌ ❎ ⭕ 🚫 ⛔ ⚠️ ❗ ❓ ❕ ❔ ‼️ ⁉️ 💯 🔥 ✨ ⭐ 🌟 💫 ⚡ 💥 💢 💤 💬 💭 🗯️ ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 💕 💖 👉 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ 🔄 🔁 ➕ ➖ ✖️ ➗ 🟥 🟧 🟨 🟩 🟦 🟪 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🔺 🔻 🔸 🔹 🆕 🆗 🆙 🆒 🆓 ℹ️ 🔝 🔜 ©️ ®️ ™️' },
  { name: '物品', icon: '💡', items: '💡 📌 📍 📎 🖇️ 📝 ✏️ 🖊️ 🖍️ 📒 📓 📔 📕 📗 📘 📙 📚 📖 🔖 🏷️ 📄 📃 📑 📊 📈 📉 🗂️ 📁 📂 🗃️ 🗄️ 🗑️ 📅 📆 🗓️ ⏰ ⏱️ ⏳ ⌛ 💻 🖥️ ⌨️ 🖱️ 📱 💾 💿 🔋 🔌 🔍 🔎 🔒 🔓 🔑 🛠️ 🔧 🔨 ⚙️ 🧪 🧬 🔬 🔭 📡 🎯 🧩 🎮 🎲 🎨 🎵 🎧 📷 🎬 📢 📣 🔔 🔕 🎁 🏆 🥇 🥈 🥉 🏅 🎉 🎊 🎈 💰 💳 📦 ✉️ 📧 📮 🚀 ✈️ 🚗 🚲 🏠 🏫 🏢' },
  { name: '自然', icon: '🌱', items: '🌞 🌝 🌛 🌙 ⭐ 🌈 ☀️ 🌤️ ⛅ ☁️ 🌧️ ⛈️ 🌩️ ❄️ ☃️ 🌊 💧 🌪️ 🌍 🌏 🌋 🏔️ 🌲 🌳 🌴 🌵 🌱 🌿 ☘️ 🍀 🍁 🍂 🍃 🌸 🌺 🌻 🌹 🌷 🌼 💐 🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🐺 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🐬 🐳 🐟 🦀' },
  { name: '食物', icon: '🍎', items: '🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥕 🌽 🌶️ 🥔 🍠 🥐 🍞 🧀 🥚 🍳 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🍜 🍝 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍢 🍡 🍧 🍨 🍦 🥧 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🥛 ☕ 🍵 🧋 🥤 🍺 🍻 🥂 🍷 🍹' },
]

const RECENT_KEY = 'editor-recent-emoji'

export function recentEmoji(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]').filter((item: unknown) => typeof item === 'string').slice(0, 24) }
  catch { return [] }
}

export function rememberEmoji(emoji: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recentEmoji().filter(item => item !== emoji)].slice(0, 24))) }
  catch { /* 隐私模式下不记录 */ }
}

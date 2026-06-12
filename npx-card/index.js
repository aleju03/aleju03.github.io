#!/usr/bin/env node
// Alejandro Jiménez's terminal business card. Zero dependencies.

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const BLUE = '\x1b[38;2;37;99;235m'
const STONE = '\x1b[38;2;168;162;158m'

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length

const rows = [
  '',
  `${BOLD}Alejandro Jiménez${RESET}`,
  `${STONE}full-stack developer ${DIM}·${RESET}${STONE} Costa Rica${RESET}`,
  '',
  `${STONE}github${RESET}     ${BLUE}github.com/aleju03${RESET}`,
  `${STONE}linkedin${RESET}   ${BLUE}linkedin.com/in/alejandro-jiménez-ulloa-692196329${RESET}`,
  `${STONE}email${RESET}      ${BLUE}alejimenezu@gmail.com${RESET}`,
  '',
  `${DIM}react frontends, node backends,${RESET}`,
  `${DIM}and the server they run on.${RESET}`,
  '',
  `${STONE}card${RESET}       ${DIM}npx aleju${RESET}`,
  '',
]

const width = Math.max(...rows.map(visible)) + 6
const top = `${BLUE}╭${'─'.repeat(width)}╮${RESET}`
const bottom = `${BLUE}╰${'─'.repeat(width)}╯${RESET}`

console.log('')
console.log(`  ${top}`)
for (const row of rows) {
  const pad = width - visible(row) - 3
  console.log(`  ${BLUE}│${RESET}   ${row}${' '.repeat(pad)}${BLUE}│${RESET}`)
}
console.log(`  ${bottom}`)
console.log('')

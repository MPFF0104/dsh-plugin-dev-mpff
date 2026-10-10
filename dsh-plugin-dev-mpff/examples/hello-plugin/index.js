export const name = 'dsh-hello-plugin'

export function apply(ctx, config) {
  const marker = '[hello-plugin] apply() ran'
  console.log(marker)
  console.error(marker)
  console.log(`[hello-plugin] config = ${JSON.stringify(config)}`)
  ctx.on('tools/result', (exec) => {
    console.log(`[hello-plugin] tools/result: ${exec.name}`)
  })
}

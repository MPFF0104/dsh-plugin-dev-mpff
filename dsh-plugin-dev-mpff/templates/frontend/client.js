/* 前端半边只到 node --check + manifest 形状 + boot 期图组合不报错，未做端到端渲染验证。 */
window.__ModuleLoader__.load({
  id: '@local/my-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    function Badge() {
      return h('span', { style: { padding: '0 6px' } }, 'my-plugin')
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'my-plugin', order: 5 },
          Badge,
        ))
      },
    }
  },
})

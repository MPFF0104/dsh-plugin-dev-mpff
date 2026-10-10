window.__ModuleLoader__.load({
  id: 'dsh-hello-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    function HelloRow() {
      return h('span', { style: { padding: '0 6px' } }, 'hello-plugin')
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'hello-plugin', order: 5 },
          HelloRow,
        ))
      },
    }
  },
})

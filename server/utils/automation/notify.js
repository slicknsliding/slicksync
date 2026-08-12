// Delivery for the automation "Send a notification" action.
//
// Same channel priority as everything else in this app: the persistent bell
// row is written unconditionally (it's the durable record), push is the
// primary live channel, and Discord is secondary/optional - never required for
// the action to be considered successful.
//
// Gated on the `notifyOnAutomation` toggle, which unlike the other notify
// toggles defaults to ON: an automation notification only ever exists because
// an admin explicitly built a rule whose action is "notify me." Defaulting
// that to off would mean the rule they just wrote silently does nothing.

async function notifyGeneric(prisma, accountId, title, message) {
  if (!accountId || !title) throw new Error('Notification needs an account and a title')

  const { createNotification } = require('../notificationStore')
  await createNotification(prisma, accountId, {
    type: 'automation',
    title,
    body: message || '',
    url: '/automation',
  }).catch(() => null)

  let cfg = null
  try {
    const account = await prisma.appAccount.findUnique({ where: { id: accountId }, select: { sync: true } })
    cfg = account?.sync
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
  } catch { /* fall through - a settings read failure shouldn't lose the bell row above */ }

  const enabled = !(cfg && typeof cfg === 'object' && cfg.notifyOnAutomation === false)
  if (!enabled) return

  try {
    const { sendPushToAccount } = require('../pushNotifications')
    // Deliberately NOT notifyPushForType: that helper hard-requires the toggle
    // to be exactly `true`, which would suppress this action for every account
    // that has never opened Settings since this shipped (the field is simply
    // absent there). The default-on reasoning above is applied here instead.
    if (typeof sendPushToAccount === 'function') {
      await sendPushToAccount(prisma, accountId, {
        title,
        body: message || '',
        icon: '/android-chrome-192x192.png',
        url: '/automation',
      })
    }
  } catch { /* push is best-effort */ }

  try {
    const webhookUrl = cfg && typeof cfg === 'object' ? cfg.webhookUrl : null
    if (webhookUrl) {
      const { postDiscord } = require('../notify')
      await postDiscord(webhookUrl, `**${title}**\n${message || ''}`)
    }
  } catch { /* Discord is secondary - never fail the action on it */ }
}

module.exports = { notifyGeneric }

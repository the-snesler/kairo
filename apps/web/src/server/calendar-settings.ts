import { eq } from 'drizzle-orm'
import { db, taskConnection, userCalendarSetting } from '@kairo/db'
import { retargetProjections, syncTaskBlocks } from '@kairo/core'
import { taskMirrorCalendarId } from './sync'

// The caller validates ownership and writability before changing a role.
export function setCalendarRoleForUser(
  userId: string,
  data: {
    calendarId: string
    role: 'default' | 'maybe' | 'tasks'
    active: boolean
  },
) {
  const field = { default: 'isDefault', maybe: 'isMaybe', tasks: 'isTasks' } as const
  const key = field[data.role]
  db.transaction((tx) => {
    if (data.active)
      tx.update(userCalendarSetting)
        .set({ [key]: false })
        .where(eq(userCalendarSetting.userId, userId))
        .run()
    tx.insert(userCalendarSetting)
      .values({ userId, calendarId: data.calendarId, [key]: data.active })
      .onConflictDoUpdate({
        target: [userCalendarSetting.userId, userCalendarSetting.calendarId],
        set: { [key]: data.active },
      })
      .run()
    if (data.active && data.role !== 'tasks')
      retargetProjections(tx, userId, data.role === 'default' ? 'yes' : 'maybe', data.calendarId)
    if (data.role === 'tasks' || data.role === 'default') {
      const calendarId = taskMirrorCalendarId(userId, tx)
      const connections = tx.select().from(taskConnection).where(eq(taskConnection.ownerUserId, userId)).all()
      for (const connection of connections) syncTaskBlocks(tx, { connectionId: connection.id }, calendarId)
    }
  })
}

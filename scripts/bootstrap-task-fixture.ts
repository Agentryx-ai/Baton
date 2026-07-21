import { createLifecyclePlan, installScheduledTask, uninstallScheduledTask } from '../server/windows-lifecycle.ts'

const operation = process.argv[2]
const plan = createLifecyclePlan()
if (operation === 'install') await installScheduledTask(true, plan)
else if (operation === 'uninstall') await uninstallScheduledTask(plan)
else throw new Error('Expected install or uninstall')

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(resolve(root, 'client-plugin/lib'), { recursive: true })
await copyFile(resolve(root, 'client/client.js'), resolve(root, 'client-plugin/lib/client.js'))
console.log('built client-plugin/lib/client.js')

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/plugin.mjs'

test('plugin Controller factory preserves the Host project root and rejects other projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-plugin-project-root-'))
  const projectRoot = join(root, 'project-a')
  const alternateRoot = join(root, 'project-b')
  const artifactRoot = join(root, 'artifacts')
  const projectAlias = join(root, 'project-a-alias')
  const alternateAlias = join(root, 'project-b-alias')
  await mkdir(projectRoot)
  await mkdir(alternateRoot)
  await mkdir(artifactRoot)
  await symlink(projectRoot, projectAlias)
  await symlink(alternateRoot, alternateAlias)
  const services = new Map()
  const ctx = {
    agents: {},
    provide(name, service) { services.set(name, service) },
    inject(_dependencies, callback) { callback({ commands: { register() {} } }) },
  }

  apply(ctx, { projectRoot, artifactRoot })
  const controllerFactory = services.get('dshDevLoopController')
  const canonicalRoot = await realpath(projectRoot)

  const controller = await controllerFactory.create()
  assert.equal(controller.projectRoot, canonicalRoot)
  await assert.rejects(controllerFactory.create({ projectRoot: alternateRoot }), /projectRoot must match configured projectRoot/)
  await assert.rejects(controllerFactory.create({ projectRoot: alternateAlias }), /projectRoot must match configured projectRoot/)

  const aliasController = await controllerFactory.create({ projectRoot: projectAlias })
  assert.equal(aliasController.projectRoot, canonicalRoot)
})

test('plugin Controller factory rejects a missing Host project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-plugin-missing-project-root-'))
  const artifactRoot = join(root, 'artifacts')
  await mkdir(artifactRoot)
  const previousProjectRoot = process.env.DSH_DEV_LOOP_PROJECT_ROOT
  delete process.env.DSH_DEV_LOOP_PROJECT_ROOT
  try {
    const services = new Map()
    const ctx = {
      agents: {},
      provide(name, service) { services.set(name, service) },
      inject(_dependencies, callback) { callback({ commands: { register() {} } }) },
    }

    apply(ctx, { artifactRoot })
    const controllerFactory = services.get('dshDevLoopController')

    await assert.rejects(controllerFactory.create(), /configured projectRoot must be an absolute path/)
  } finally {
    if (previousProjectRoot === undefined) delete process.env.DSH_DEV_LOOP_PROJECT_ROOT
    else process.env.DSH_DEV_LOOP_PROJECT_ROOT = previousProjectRoot
  }
})

test('plugin Controller factory preserves the Host artifact root and accepts its canonical alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-plugin-artifact-root-'))
  const projectRoot = join(root, 'project')
  const artifactRoot = join(root, 'artifacts')
  const alternateRoot = join(root, 'alternate-artifacts')
  const alias = join(root, 'artifact-alias')
  await mkdir(projectRoot)
  await mkdir(artifactRoot)
  await symlink(artifactRoot, alias)
  const services = new Map()
  const ctx = {
    agents: {},
    provide(name, service) { services.set(name, service) },
    inject(_dependencies, callback) { callback({ commands: { register() {} } }) },
  }

  apply(ctx, { projectRoot, artifactRoot })
  const controllerFactory = services.get('dshDevLoopController')

  await assert.rejects(controllerFactory.create({ artifactRoot: alternateRoot }), /configured artifactRoot/)
  await assert.rejects(access(alternateRoot), { code: 'ENOENT' })

  const controller = await controllerFactory.create({ artifactRoot: alias })
  assert.equal(controller.store.root, await realpath(artifactRoot))
})

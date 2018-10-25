import https from 'https'
import path from 'path'
import enableDestroy from 'server-destroy'
import launchMiddleware from 'launch-editor-middleware'
import serveStatic from 'serve-static'
import chalk from 'chalk'
import ip from 'ip'
import consola from 'consola'
import connect from 'connect'
import { determineGlobals, isUrl, NuxtConfig } from '@nuxt/common'

import renderAndGetWindow from './jsdom'
import nuxtMiddleware from './middleware/nuxt'
import errorMiddleware from './middleware/error'

export default class Server {
  constructor(nuxt) {
    this.nuxt = nuxt
    this.options = nuxt.options

    this.globals = determineGlobals(nuxt.options.globalName, nuxt.options.globals)

    this.publicPath = isUrl(this.options.build.publicPath)
      ? NuxtConfig.build.publicPath
      : this.options.build.publicPath

    // Runtime shared resources
    this.resources = {}

    // Will be available on dev
    this.webpackDevMiddleware = null
    this.webpackHotMiddleware = null

    // Create new connect instance
    this.app = connect()
  }

  async ready() {
    await this.nuxt.callHook('render:before', this, this.options.render)

    // Initialize vue-renderer
    const { VueRenderer } = await import('@nuxt/vue-renderer')
    this.renderer = new VueRenderer(this)
    await this.renderer.ready()

    // Setup nuxt middleware
    await this.setupMiddleware()

    // Call done hook
    await this.nuxt.callHook('render:done', this)
  }

  async setupMiddleware() {
    // Apply setupMiddleware from modules first
    await this.nuxt.callHook('render:setupMiddleware', this.app)

    // Compression middleware for production
    if (!this.options.dev) {
      const compressor = this.options.render.compressor
      if (typeof compressor === 'object') {
        // If only setting for `compression` are provided, require the module and insert
        const compression = this.nuxt.resolver.requireModule('compression')
        this.useMiddleware(compression(compressor))
      } else {
        // Else, require own compression middleware
        this.useMiddleware(compressor)
      }
    }

    // Add webpack middleware support only for development
    if (this.options.dev) {
      this.useMiddleware(async (req, res, next) => {
        if (this.webpackDevMiddleware) {
          await this.webpackDevMiddleware(req, res)
        }
        if (this.webpackHotMiddleware) {
          await this.webpackHotMiddleware(req, res)
        }
        next()
      })
    }

    // open in editor for debug mode only
    if (this.options.debug && this.options.dev) {
      this.useMiddleware({
        path: '__open-in-editor',
        handler: launchMiddleware(this.options.editor)
      })
    }

    // For serving static/ files to /
    const staticMiddleware = serveStatic(
      path.resolve(this.options.srcDir, this.options.dir.static),
      this.options.render.static
    )
    staticMiddleware.prefix = this.options.render.static.prefix
    this.useMiddleware(staticMiddleware)

    // Serve .nuxt/dist/client files only for production
    // For dev they will be served with devMiddleware
    if (!this.options.dev) {
      const distDir = path.resolve(this.options.buildDir, 'dist', 'client')
      this.useMiddleware({
        path: this.publicPath,
        handler: serveStatic(
          distDir,
          this.options.render.dist
        )
      })
    }

    // Add User provided middleware
    this.options.serverMiddleware.forEach((m) => {
      this.useMiddleware(m)
    })

    // Finally use nuxtMiddleware
    this.useMiddleware(nuxtMiddleware({
      options: this.options,
      renderRoute: this.renderRoute.bind(this),
      resources: this.resources
    }))

    // Error middleware for errors that occurred in middleware that declared above
    // Middleware should exactly take 4 arguments
    // https://github.com/senchalabs/connect#error-middleware

    // Apply errorMiddleware from modules first
    await this.nuxt.callHook('render:errorMiddleware', this.app)

    // Apply errorMiddleware from Nuxt
    this.useMiddleware(errorMiddleware({
      resources: this.resources,
      options: this.options
    }))
  }

  useMiddleware(middleware) {
    // Resolve middleware
    if (typeof middleware === 'string') {
      middleware = this.nuxt.resolver.requireModule(middleware)
    }

    // Resolve handler
    if (typeof middleware.handler === 'string') {
      middleware.handler = this.nuxt.resolver.requireModule(middleware.handler)
    }
    const handler = middleware.handler || middleware

    // Resolve path
    const path = (
      (middleware.prefix !== false ? this.options.router.base : '') +
      (typeof middleware.path === 'string' ? middleware.path : '')
    ).replace(/\/\//g, '/')

    // Use middleware
    this.app.use(path, handler)
  }

  renderRoute() {
    return this.renderer.renderRoute.apply(this.renderer, arguments)
  }

  loadResources() {
    return this.renderer.loadResources.apply(this.renderer, arguments)
  }

  renderAndGetWindow(url, opts = {}) {
    return renderAndGetWindow(url, opts, {
      loadedCallback: this.globals.loadedCallback
    })
  }

  showReady(clear = true) {
    if (this.readyMessage) {
      consola.ready({
        message: this.readyMessage,
        badge: true,
        clear
      })
    }
  }

  listen(port, host, socket) {
    return this.ready().then(() => new Promise((resolve, reject) => {
      if (!socket && typeof this.options.server.socket === 'string') {
        socket = this.options.server.socket
      }

      const args = { exclusive: false }

      if (socket) {
        args.path = socket
      } else {
        args.port = port || this.options.server.port
        args.host = host || this.options.server.host
      }

      let appServer
      const isHttps = Boolean(this.options.server.https)

      if (isHttps) {
        let httpsOptions

        if (this.options.server.https === true) {
          httpsOptions = {}
        } else {
          httpsOptions = this.options.server.https
        }

        appServer = https.createServer(httpsOptions, this.app)
      } else {
        appServer = this.app
      }

      const server = appServer.listen(
        args,
        (err) => {
          /* istanbul ignore if */
          if (err) {
            return reject(err)
          }

          let listenURL

          if (!socket) {
            ({ address: host, port } = server.address())
            if (host === '127.0.0.1') {
              host = 'localhost'
            } else if (host === '0.0.0.0') {
              host = ip.address()
            }

            listenURL = chalk.underline.blue(`http${isHttps ? 's' : ''}://${host}:${port}`)
            this.readyMessage = `Listening on ${listenURL}`
          } else {
            listenURL = chalk.underline.blue(`unix+http://${socket}`)
            this.readyMessage = `Listening on ${listenURL}`
          }

          // Close server on nuxt close
          this.nuxt.hook(
            'close',
            () =>
              new Promise((resolve, reject) => {
                // Destroy server by forcing every connection to be closed
                server.listening && server.destroy((err) => {
                  consola.debug('server closed')
                  /* istanbul ignore if */
                  if (err) {
                    return reject(err)
                  }
                  resolve()
                })
              })
          )

          if (socket) {
            this.nuxt.callHook('listen', server, { path: socket }).then(resolve)
          } else {
            this.nuxt.callHook('listen', server, { port, host }).then(resolve)
          }
        }
      )

      // Add server.destroy(cb) method
      enableDestroy(server)
    }))
  }
}

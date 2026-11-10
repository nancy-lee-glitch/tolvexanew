import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import url from 'url';
import { defineConfig, type Plugin } from 'vite';

function apiDevMiddleware(): Plugin {
  return {
    name: 'api-dev-middleware',
    configureServer(server) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        if (!req.url?.startsWith('/api/')) return next();
        const parsedUrl = url.parse(req.url, true);
        const pathname = (parsedUrl.pathname || '').replace(/\/$/, '');

        let routeFile = '';
        if (pathname === '/api/auth/register') routeFile = './api/auth/register.ts';
        else if (pathname === '/api/admin/users') routeFile = './api/admin/users.ts';
        else if (pathname === '/api/admin/vip-codes') routeFile = './api/admin/vip-codes.ts';
        else if (pathname === '/api/admin/pricing') routeFile = './api/admin/pricing.ts';
        else if (pathname === '/api/admin/settings' || pathname === '/api/settings') routeFile = './api/admin/settings.ts';
        else if (pathname === '/api/admin/blog') routeFile = './api/admin/blog.ts';
        else if (pathname === '/api/admin/orders') routeFile = './api/admin/orders.ts';
        else if (pathname === '/api/admin/audit') routeFile = './api/admin/audit.ts';

        if (routeFile) {
          try {
            if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
              const buffers: any[] = [];
              for await (const chunk of req) {
                buffers.push(chunk);
              }
              const data = Buffer.concat(buffers).toString();
              if (data) {
                try {
                  req.body = JSON.parse(data);
                } catch {
                  req.body = data;
                }
              } else {
                req.body = {};
              }
            } else {
              req.body = {};
            }

            req.query = parsedUrl.query || {};

            res.status = (code: number) => {
              res.statusCode = code;
              return res;
            };
            res.json = (obj: any) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(obj));
            };

            const mod = await server.ssrLoadModule(routeFile);
            return await mod.default(req, res);
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ ok: false, error: err?.message || 'Server error' }));
          }
        }
        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), apiDevMiddleware()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client'],
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

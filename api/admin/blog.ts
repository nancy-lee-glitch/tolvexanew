import { requireAdmin, authenticateRequest } from '../_lib/auth.js';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin.js';
import { logAdminAudit } from '../_lib/audit.js';

export default async function handler(req: any, res: any) {
  const supabase = getSupabaseAdmin();

  // GET: Public returns published articles; Admin can view all including drafts
  if (req.method === 'GET') {
    const auth = await authenticateRequest(req);
    const isAdmin = auth?.isAdmin || false;

    let dbQuery = supabase
      .from('blog_posts')
      .select('*')
      .order('created_at', { ascending: false });

    if (!isAdmin) {
      dbQuery = dbQuery.eq('is_published', true);
    }

    const { data: posts, error } = await dbQuery;
    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true, posts: posts || [] });
  }

  // POST: Admin create post
  if (req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const {
      title,
      slug,
      excerpt,
      body,
      cover_url,
      category,
      author,
      author_role,
      read_time,
      is_published,
    } = req.body || {};

    if (!title || !slug) {
      return res.status(400).json({ ok: false, error: 'Title and unique slug are required.' });
    }

    const cleanSlug = String(slug)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-');

    const { data: created, error } = await supabase
      .from('blog_posts')
      .insert({
        title: String(title).trim(),
        slug: cleanSlug,
        excerpt: excerpt ? String(excerpt).trim() : null,
        body: body ? String(body).trim() : null,
        cover_url: cover_url ? String(cover_url).trim() : null,
        category: category ? String(category).trim() : 'Quantitative Alpha',
        author: author ? String(author).trim() : 'Tickvere Research Desk',
        author_role: author_role ? String(author_role).trim() : 'Quantitative Research',
        read_time: read_time ? String(read_time).trim() : '4 min read',
        is_published: is_published !== false,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    await logAdminAudit(
      admin.userId,
      'CREATE_BLOG_POST',
      'blog_posts',
      created.id,
      { title: created.title, slug: created.slug }
    );

    return res.status(201).json({ ok: true, post: created });
  }

  // PUT: Admin update post
  if (req.method === 'PUT') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { id, ...updates } = req.body || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Blog post id is required.' });
    }

    const { data: updated, error } = await supabase
      .from('blog_posts')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    await logAdminAudit(
      admin.userId,
      'UPDATE_BLOG_POST',
      'blog_posts',
      String(id),
      { updates }
    );

    return res.json({ ok: true, post: updated });
  }

  // DELETE: Admin delete post
  if (req.method === 'DELETE') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const id = req.query?.id || req.body?.id;
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Blog post id is required.' });
    }

    const { error } = await supabase
      .from('blog_posts')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    await logAdminAudit(
      admin.userId,
      'DELETE_BLOG_POST',
      'blog_posts',
      String(id)
    );

    return res.json({ ok: true, message: 'Blog post deleted.' });
  }

  res.setHeader('Allow', 'GET, POST, PUT, DELETE');
  return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}

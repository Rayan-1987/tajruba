import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { openDatabase } from '../server/db.ts';
import { seedDatabase } from '../server/seed.ts';
import { createApi } from '../server/api.ts';

const root = new URL('..', import.meta.url).pathname;

function startServer() {
  const db = openDatabase(':memory:');
  seedDatabase(db, root);
  const app = express();
  app.use('/api', createApi(db, 'test-secret-at-least-32-characters-long', root));
  return new Promise<{ server: Server; baseUrl: string; db: typeof db }>((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, db });
    });
  });
}

function extractCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0];
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(res.status, 200);
  return extractCookie(res);
}

test('only a SystemAdmin can create, edit, and deactivate a department', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const qualityCookie = await login(baseUrl, 'quality@tajruba.sa', 'Quality123!');
    const denied = await fetch(`${baseUrl}/api/departments`, {
      method: 'POST',
      headers: { cookie: qualityCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ nameAr: 'قسم تجريبي', nameEn: 'Test Ward', serviceType: 'IP' })
    });
    assert.equal(denied.status, 403);

    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const created = await fetch(`${baseUrl}/api/departments`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ nameAr: 'قسم تجريبي', nameEn: 'Test Ward', serviceType: 'IP' })
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };

    const renamed = await fetch(`${baseUrl}/api/departments/${id}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ nameAr: 'قسم معدّل' })
    });
    assert.equal(renamed.status, 200);

    const listAfterCreate = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: { id: string; name_ar: string }[];
    };
    assert.ok(listAfterCreate.departments.some((d) => d.id === id && d.name_ar === 'قسم معدّل'));

    const deactivated = await fetch(`${baseUrl}/api/departments/${id}`, { method: 'DELETE', headers: { cookie: adminCookie } });
    assert.equal(deactivated.status, 200);

    const listAfterDeactivate = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: { id: string }[];
    };
    assert.ok(!listAfterDeactivate.departments.some((d) => d.id === id), 'deactivated department must not appear in the default list');

    const listIncludingInactive = (await (
      await fetch(`${baseUrl}/api/departments?includeInactive=1`, { headers: { cookie: adminCookie } })
    ).json()) as { departments: { id: string; active: number }[] };
    const found = listIncludingInactive.departments.find((d) => d.id === id);
    assert.ok(found);
    assert.equal(found!.active, 0);
  } finally {
    server.close();
    db.close();
  }
});

test('a SystemAdmin can create a user, change their role, and cannot deactivate themselves', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');
    const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: adminCookie } });
    const me = (await meRes.json()) as { user: { id: string } };

    const departments = (await (await fetch(`${baseUrl}/api/departments`, { headers: { cookie: adminCookie } })).json()) as {
      departments: { id: string; service_type: string }[];
    };
    const edDept = departments.departments.find((d) => d.service_type === 'ED')!;

    const created = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'new-manager@tajruba.sa',
        password: 'NewManager123!',
        fullName: 'مدير جديد',
        role: 'DepartmentManager',
        departmentId: edDept.id
      })
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };

    const newUserCookie = await login(baseUrl, 'new-manager@tajruba.sa', 'NewManager123!');
    assert.ok(newUserCookie.length > 0);

    const promoted = await fetch(`${baseUrl}/api/users/${id}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'QualityManager' })
    });
    assert.equal(promoted.status, 200);

    const usersList = (await (await fetch(`${baseUrl}/api/users`, { headers: { cookie: adminCookie } })).json()) as {
      users: { id: string; role: string; department_id: string | null }[];
    };
    const promotedUser = usersList.users.find((u) => u.id === id)!;
    assert.equal(promotedUser.role, 'QualityManager');
    assert.equal(promotedUser.department_id, null, 'department_id must clear when role is no longer DepartmentManager');

    const selfDeactivate = await fetch(`${baseUrl}/api/users/${me.user.id}`, { method: 'DELETE', headers: { cookie: adminCookie } });
    assert.equal(selfDeactivate.status, 400);

    const deactivated = await fetch(`${baseUrl}/api/users/${id}`, { method: 'DELETE', headers: { cookie: adminCookie } });
    assert.equal(deactivated.status, 200);

    const loginAfterDeactivate = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new-manager@tajruba.sa', password: 'NewManager123!' })
    });
    assert.equal(loginAfterDeactivate.status, 401, 'a deactivated user must not be able to log in');
  } finally {
    server.close();
    db.close();
  }
});

test('a new domain and question are provisioned into the matching survey template', async () => {
  const { server, baseUrl, db } = await startServer();
  try {
    const adminCookie = await login(baseUrl, 'admin@tajruba.sa', 'Tajruba123!');

    const domainRes = await fetch(`${baseUrl}/api/question-bank/domains`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ED_TESTDOMAIN', nameAr: 'محور تجريبي', nameEn: 'Test Domain', serviceType: 'ED', benchmarkTopBoxPercent: 80 })
    });
    assert.equal(domainRes.status, 201);
    const { id: domainId } = (await domainRes.json()) as { id: string };

    const dupDomain = await fetch(`${baseUrl}/api/question-bank/domains`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ED_TESTDOMAIN', nameAr: 'تكرار', nameEn: 'Dup', serviceType: 'ED', benchmarkTopBoxPercent: 80 })
    });
    assert.equal(dupDomain.status, 409);

    const questionRes = await fetch(`${baseUrl}/api/question-bank/questions`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'ED-TEST-001',
        domainId,
        textAr: 'سؤال تجريبي',
        textEn: 'Test question',
        type: 'likert5'
      })
    });
    assert.equal(questionRes.status, 201);
    const { id: questionId } = (await questionRes.json()) as { id: string };

    const templates = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
      templates: { service_type: string; questions: { id: string; text_ar: string }[] }[];
    };
    const edTemplate = templates.templates.find((t) => t.service_type === 'ED')!;
    assert.ok(edTemplate.questions.some((q) => q.id === questionId), 'new question must appear in the ED survey template');

    const deactivated = await fetch(`${baseUrl}/api/question-bank/questions/${questionId}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ active: false })
    });
    assert.equal(deactivated.status, 200);

    const templatesAfter = (await (await fetch(`${baseUrl}/api/templates`, { headers: { cookie: adminCookie } })).json()) as {
      templates: { service_type: string; questions: { id: string }[] }[];
    };
    const edTemplateAfter = templatesAfter.templates.find((t) => t.service_type === 'ED')!;
    assert.ok(!edTemplateAfter.questions.some((q) => q.id === questionId), 'a deactivated question must disappear from the live survey');
  } finally {
    server.close();
    db.close();
  }
});

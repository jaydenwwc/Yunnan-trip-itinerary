const RECORD_COLLECTIONS = ["bills", "travelers", "todos", "tickets"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function emptySnapshot() {
  return {
    version: 1,
    settings: null,
    bills: [],
    travelers: [],
    todos: [],
    tickets: [],
    updatedAt: new Date().toISOString()
  };
}

function requestedCollections(url) {
  const requested = (url.searchParams.get("collections") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return [...new Set(requested)].filter((item) =>
    RECORD_COLLECTIONS.includes(item)
  );
}

async function loadSnapshot(db, tripId, collections) {
  const snapshot = emptySnapshot();
  let latest = "";

  for (const collection of collections) {
    const { results = [] } = await db
      .prepare(`
        SELECT value_json, updated_at
        FROM runtime_records
        WHERE trip_id = ? AND collection = ?
        ORDER BY updated_at ASC, record_id ASC
      `)
      .bind(tripId, collection)
      .all();

    snapshot[collection] = results.flatMap((row) => {
      try {
        const value = JSON.parse(row.value_json);
        if (row.updated_at && row.updated_at > latest) latest = row.updated_at;
        return value && typeof value === "object" ? [value] : [];
      } catch {
        return [];
      }
    });
  }

  if (latest) snapshot.updatedAt = latest;
  return snapshot;
}

async function applyChanges(db, tripId, collections, changes) {
  const now = new Date().toISOString();
  const statements = [];

  for (const change of changes) {
    const collection = String(change?.collection || "");
    const id = String(change?.id || "").trim();
    const op = String(change?.op || "");

    if (!collections.includes(collection)) {
      throw new Error(`Collection not allowed: ${collection}`);
    }
    if (!id) throw new Error("Missing record id");

    if (op === "delete") {
      statements.push(
        db.prepare(`
          DELETE FROM runtime_records
          WHERE trip_id = ? AND collection = ? AND record_id = ?
        `).bind(tripId, collection, id)
      );
      continue;
    }

    if (op !== "upsert" || !change.value || typeof change.value !== "object") {
      throw new Error("Invalid change");
    }

    statements.push(
      db.prepare(`
        INSERT INTO runtime_records
          (trip_id, collection, record_id, value_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(trip_id, collection, record_id)
        DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).bind(
        tripId,
        collection,
        id,
        JSON.stringify(change.value),
        now
      )
    );
  }

  if (statements.length) await db.batch(statements);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/trip\/([^/]+)$/);

    if (!match) {
      return new Response("Not found", { status: 404 });
    }

    const tripId = decodeURIComponent(match[1]);
    const collections = requestedCollections(url);

    if (!collections.length) {
      return json({ error: "No valid collections requested" }, 400);
    }

    try {
      if (request.method === "GET") {
        return json(await loadSnapshot(env.DB, tripId, collections));
      }

      if (request.method === "POST") {
        const body = await request.json();
        const changes = Array.isArray(body?.changes) ? body.changes : [];

        await applyChanges(env.DB, tripId, collections, changes);

        return json(await loadSnapshot(env.DB, tripId, collections));
      }

      return json({ error: "Method not allowed" }, 405);
    } catch (error) {
      console.error(error);
      return json({ error: "Ledger API error" }, 500);
    }
  }
};

import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * Mongoose uslubidagi yupqa qatlam, ichida PostgreSQL.
 *
 * Nega shunday: kodda ~160 ta so'rov bor va ularning ko'pi "hujjatni
 * o'zgartirib .save() qilish" uslubida yozilgan. Har birini qo'lda SQL ga
 * aylantirish katta diff va katta xavf bo'lardi. Shuning uchun chaqiruv
 * joylari tegilmaydi — ular ishlatadigan API shu yerda qaytarilgan, xavf esa
 * bitta faylga jamlangan va mavjud testlar bilan qoplangan.
 *
 * Qo'llab-quvvatlanadigani ataylab TOR — faqat shu loyihada ishlatilgani:
 *   filtr:    tenglik, null, $in $nin $ne $lt $lte $gt $gte $or $and $exists
 *   yangilash: $set, $unset (jsonb ichidagi "values.kalit" yo'li ham), upsert
 *   zanjir:   .sort() .limit() .select() .lean()
 *   hujjat:   maydonlar, ._id, .id, .save(), .set(), .toObject()
 * Yangi narsa kerak bo'lsa — bu yerga ongli ravishda qo'shiladi.
 *
 * Mongo'ning aggregate() quvuri tarjima qilinmaydi. Uning o'rniga ishlatilgan
 * ikki holat uchun aniq metod bor: sample() va countBy().
 */

// BIGINT ni Postgres matn sifatida qaytaradi, kodda esa chatId/telegramId son.
// Telegram id'lari 2^53 dan ancha kichik, shuning uchun songa o'tkazish xavfsiz.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Baza ulanmagan — avval connectDatabase() chaqiring');
  return pool;
}

export function setPool(p: pg.Pool | undefined): void {
  pool = p;
}

export type Row = Record<string, any>;

/** Hujjatga qo'shiladigan metodlar. .lean() natijasida bular bo'lmaydi. */
export interface DocApi<T> {
  _id: string;
  /** Mongoose'dagidek _id ning matn ko'rinishi. */
  readonly id: string;
  save(): Promise<void>;
  toObject(): T & { _id: string };
  set(patch: Partial<T> & Row): void;
}

export type Doc<T extends Row = Row> = T & DocApi<T>;

/** .lean() oddiy qator qaytaradi — hujjat metodlari yo'q. */
type Lean<X> = X extends readonly (infer E)[]
  ? Lean<E>[]
  : X extends null
    ? null
    : Omit<X, keyof DocApi<unknown>> & { _id: string };

// ============ FILTR -> WHERE ============

function quote(field: string): string {
  return `"${field.replace(/"/g, '')}"`;
}

function buildCondition(field: string, cond: unknown, params: unknown[]): string {
  const col = quote(field);

  if (cond === null || cond === undefined) return `${col} IS NULL`;

  if (typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
    const parts: string[] = [];
    for (const [op, raw] of Object.entries(cond as Record<string, unknown>)) {
      switch (op) {
        case '$in':
          if (!Array.isArray(raw) || raw.length === 0) return 'FALSE';
          params.push(raw);
          parts.push(`${col} = ANY($${params.length})`);
          break;
        case '$nin':
          if (!Array.isArray(raw) || raw.length === 0) break;
          params.push(raw);
          parts.push(`NOT (${col} = ANY($${params.length}))`);
          break;
        case '$ne':
          if (raw === null) {
            parts.push(`${col} IS NOT NULL`);
            break;
          }
          params.push(raw);
          // IS DISTINCT FROM: NULL ham "teng emas" hisoblanadi, Mongo'dagidek
          parts.push(`${col} IS DISTINCT FROM $${params.length}`);
          break;
        case '$lt':
        case '$lte':
        case '$gt':
        case '$gte': {
          const sign = { $lt: '<', $lte: '<=', $gt: '>', $gte: '>=' }[op];
          params.push(raw);
          parts.push(`${col} ${sign} $${params.length}`);
          break;
        }
        case '$exists':
          parts.push(raw ? `${col} IS NOT NULL` : `${col} IS NULL`);
          break;
        default:
          throw new Error(`odm: qo'llab-quvvatlanmaydigan operator ${op} (${field})`);
      }
    }
    return parts.length ? parts.join(' AND ') : 'TRUE';
  }

  params.push(cond);
  return `${col} = $${params.length}`;
}

export function buildWhere(filter: Row | undefined, params: unknown[]): string {
  if (!filter || Object.keys(filter).length === 0) return 'TRUE';

  const parts: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$or' || key === '$and') {
      const list = (value as Row[]).map((f) => `(${buildWhere(f, params)})`);
      if (list.length) parts.push(`(${list.join(key === '$or' ? ' OR ' : ' AND ')})`);
      continue;
    }
    parts.push(buildCondition(key, value, params));
  }
  return parts.length ? parts.join(' AND ') : 'TRUE';
}

// ============ YANGILASH -> SET ============

/** "values.theme" kabi yo'l jsonb ustuni ichiga tegishli. */
function splitPath(key: string): { column: string; path: string[] } {
  const [column, ...path] = key.split('.');
  return { column, path };
}

function buildSet(update: Row, params: unknown[], timestamps: boolean, json: ReadonlySet<string>): string {
  const $set: Row = { ...(update.$set as Row | undefined) };
  const $unset = (update.$unset ?? {}) as Row;

  // Operatorsiz berilgan maydonlar $set deb qaraladi
  for (const [k, v] of Object.entries(update)) {
    if (!k.startsWith('$')) $set[k] = v;
  }

  // Postgres bitta ustunga bitta tayinlashga ruxsat beradi, shuning uchun bir
  // ustunga tegadigan hamma o'zgarish bitta ifodaga yig'iladi — masalan
  // ikkita "values.x" yo'li jsonb_set(jsonb_set(...)) bo'lib ketadi.
  const exprs = new Map<string, string>();
  const current = (col: string): string => exprs.get(col) ?? quote(col);

  for (const [key, value] of Object.entries($set)) {
    const { column, path } = splitPath(key);
    if (path.length === 0) {
      // jsonb ustun: pg JS massivini Postgres massivi deb yuboradi, shuning
      // uchun jsonb ga tushadigan qiymatni o'zimiz JSON matnga aylantiramiz
      const jsonb = json.has(column) && value !== null && value !== undefined;
      params.push(jsonb ? JSON.stringify(value) : value);
      exprs.set(column, `$${params.length}${jsonb ? '::jsonb' : ''}`);
    } else {
      params.push(path);
      const pathIdx = params.length;
      params.push(JSON.stringify(value ?? null));
      exprs.set(column, `jsonb_set(COALESCE(${current(column)}, '{}'::jsonb), $${pathIdx}::text[], $${params.length}::jsonb, true)`);
    }
  }

  for (const key of Object.keys($unset)) {
    const { column, path } = splitPath(key);
    if (path.length === 0) {
      // Mongo'da $unset maydonni olib tashlaydi, mongoose esa o'qiganda
      // standart qiymatni qo'yadi. Postgres'dagi aynan shu narsa — DEFAULT.
      // NULL qo'yish NOT NULL ustunlarni buzardi.
      exprs.set(column, 'DEFAULT');
    } else {
      params.push(path);
      exprs.set(column, `COALESCE(${current(column)}, '{}'::jsonb) #- $${params.length}::text[]`);
    }
  }

  const assigns = [...exprs].map(([col, expr]) => `${quote(col)} = ${expr}`);
  if (timestamps) assigns.push(`"updatedAt" = now()`);
  return assigns.join(', ');
}

// ============ HUJJAT ============

function makeDoc<T extends Row>(model: Model<T>, row: Row): Doc<T> {
  const dirty = new Set<string>();
  const data: Row = { ...row };

  return new Proxy(data, {
    get(t, key) {
      if (key === 'save') return async () => model.__save(t, dirty);
      if (key === 'toObject') return () => ({ ...t });
      if (key === 'set') {
        return (patch: Row) => {
          for (const [k, v] of Object.entries(patch)) {
            dirty.add(k);
            t[k] = v;
          }
        };
      }
      if (key === 'id') return t._id;
      return t[key as string];
    },
    set(t, key, value) {
      if (typeof key === 'string') {
        dirty.add(key);
        t[key] = value;
      }
      return true;
    },
    deleteProperty(t, key) {
      // undefined — "olib tashlandi"; saqlanganda DEFAULT ga aylanadi
      if (typeof key === 'string') {
        dirty.add(key);
        t[key] = undefined;
      }
      return true;
    },
  }) as unknown as Doc<T>;
}

// ============ SO'ROV ZANJIRI ============

class Query<R> implements PromiseLike<R> {
  private orderBy?: string;
  private max?: number;
  private cols = '*';
  private plain = false;

  constructor(
    private readonly model: Model<any>,
    private readonly filter: Row | undefined,
    private readonly mode: 'many' | 'one',
  ) {}

  sort(spec: Record<string, 1 | -1>): this {
    const parts = Object.entries(spec).map(([f, dir]) => `${quote(f)} ${dir === -1 ? 'DESC' : 'ASC'} NULLS LAST`);
    if (parts.length) this.orderBy = parts.join(', ');
    return this;
  }

  limit(n: number): this {
    // Mongo manfiy limitni boshqacha tushunadi, Postgres esa xato beradi
    this.max = Math.max(0, Math.trunc(n));
    return this;
  }

  select(fields: string): this {
    const list = fields.split(/\s+/).filter(Boolean);
    if (list.length) this.cols = ['_id', ...list.filter((f) => f !== '_id')].map(quote).join(', ');
    return this;
  }

  /**
   * Mongoose'dagidek: oddiy obyekt, kuzatuvsiz va .save() siz. Shunday
   * natijani JSON'ga berish va spread qilish xavfsiz. Faqat o'qish uchun.
   */
  lean(): Query<Lean<R>> {
    this.plain = true;
    return this as unknown as Query<Lean<R>>;
  }

  private async run(): Promise<Row[]> {
    const params: unknown[] = [];
    const where = buildWhere(this.filter, params);
    const sql =
      `SELECT ${this.cols} FROM ${this.model.table} WHERE ${where}` +
      (this.orderBy ? ` ORDER BY ${this.orderBy}` : '') +
      (this.max !== undefined ? ` LIMIT ${this.max}` : '') +
      (this.mode === 'one' && this.max === undefined ? ' LIMIT 1' : '');
    const res = await getPool().query(sql, params);
    return res.rows;
  }

  then<R1 = R, R2 = never>(
    onOk?: ((value: R) => R1 | PromiseLike<R1>) | null,
    onErr?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run()
      .then((rows) => {
        const docs = this.plain ? rows : rows.map((r) => makeDoc(this.model, r));
        return (this.mode === 'one' ? (docs[0] ?? null) : docs) as R;
      })
      .then(onOk, onErr);
  }
}

// ============ MODEL ============

export interface ModelOptions {
  /** false — jadvalda createdAt/updatedAt yo'q. */
  timestamps?: boolean;
  /** jsonb ustunlar nomi. */
  json?: readonly string[];
}

export class Model<T extends Row = Row> {
  private readonly json: ReadonlySet<string>;

  constructor(
    readonly table: string,
    private readonly opts: ModelOptions = {},
  ) {
    this.json = new Set(opts.json ?? []);
  }

  private get ts(): boolean {
    return this.opts.timestamps !== false;
  }

  find(filter?: Row): Query<Doc<T>[]> {
    return new Query<Doc<T>[]>(this, filter, 'many');
  }

  findOne(filter?: Row): Query<Doc<T> | null> {
    return new Query<Doc<T> | null>(this, filter, 'one');
  }

  findById(id: string): Query<Doc<T> | null> {
    return new Query<Doc<T> | null>(this, { _id: id }, 'one');
  }

  // Mongoose'dagidek: create() bitta obyektni ham, massivni ham oladi
  async create(data: Partial<T> & Row): Promise<Doc<T>>;
  async create(data: Array<Partial<T> & Row>): Promise<Doc<T>[]>;
  async create(data: (Partial<T> & Row) | Array<Partial<T> & Row>): Promise<Doc<T> | Doc<T>[]> {
    if (Array.isArray(data)) return this.insertMany(data);
    return makeDoc(this, await this.insert(data));
  }

  async insertMany(rows: Array<Partial<T> & Row>): Promise<Doc<T>[]> {
    const out: Doc<T>[] = [];
    for (const r of rows) out.push(await this.create(r));
    return out;
  }

  private async insert(data: Row): Promise<Row> {
    const payload: Row = { _id: data._id ?? randomUUID(), ...data };
    delete payload.id;
    // undefined — "tegilmagan" degani, DB standart qiymatini qo'yadi
    const entries = Object.entries(payload).filter(([, v]) => v !== undefined);
    const cols = entries.map(([k]) => quote(k)).join(', ');
    const holders = entries.map(([k], i) => `$${i + 1}${this.json.has(k) ? '::jsonb' : ''}`).join(', ');
    const res = await getPool().query(`INSERT INTO ${this.table} (${cols}) VALUES (${holders}) RETURNING *`, entries.map(([k, v]) => (this.json.has(k) && v !== null ? JSON.stringify(v) : v)));
    return res.rows[0];
  }

  async updateOne(filter: Row, update: Row, opts: { upsert?: boolean } = {}): Promise<{ modifiedCount: number }> {
    const params: unknown[] = [];
    const set = buildSet(update, params, this.ts, this.json);
    const where = buildWhere(filter, params);
    const res = await getPool().query(
      `UPDATE ${this.table} SET ${set} WHERE "_id" IN (SELECT "_id" FROM ${this.table} WHERE ${where} LIMIT 1)`,
      params,
    );

    if (res.rowCount === 0 && opts.upsert) {
      // Filtrdagi tenglik shartlari + $set birga yangi qator beradi
      const seed: Row = {};
      for (const [k, v] of Object.entries(filter)) {
        if (!k.startsWith('$') && (typeof v !== 'object' || v === null || v instanceof Date)) seed[k] = v;
      }
      const simple: Row = {};
      const nested: Row = {};
      for (const [k, v] of Object.entries({ ...(update.$set as Row), ...update })) {
        if (k.startsWith('$')) continue;
        if (k.includes('.')) nested[k] = v;
        else simple[k] = v;
      }
      // jsonb ichidagi yo'l INSERT'da ishlamaydi — avval qator, keyin yangilash
      await this.insert({ ...seed, ...simple });
      if (Object.keys(nested).length) await this.updateOne(filter, { $set: nested });
      return { modifiedCount: 1 };
    }

    return { modifiedCount: res.rowCount ?? 0 };
  }

  async updateMany(filter: Row, update: Row): Promise<{ modifiedCount: number }> {
    const params: unknown[] = [];
    const set = buildSet(update, params, this.ts, this.json);
    const where = buildWhere(filter, params);
    const res = await getPool().query(`UPDATE ${this.table} SET ${set} WHERE ${where}`, params);
    return { modifiedCount: res.rowCount ?? 0 };
  }

  async deleteOne(filter: Row): Promise<{ deletedCount: number }> {
    const params: unknown[] = [];
    const where = buildWhere(filter, params);
    const res = await getPool().query(
      `DELETE FROM ${this.table} WHERE "_id" IN (SELECT "_id" FROM ${this.table} WHERE ${where} LIMIT 1)`,
      params,
    );
    return { deletedCount: res.rowCount ?? 0 };
  }

  async deleteMany(filter?: Row): Promise<{ deletedCount: number }> {
    const params: unknown[] = [];
    const where = buildWhere(filter, params);
    const res = await getPool().query(`DELETE FROM ${this.table} WHERE ${where}`, params);
    return { deletedCount: res.rowCount ?? 0 };
  }

  async countDocuments(filter?: Row): Promise<number> {
    const params: unknown[] = [];
    const where = buildWhere(filter, params);
    const res = await getPool().query(`SELECT count(*)::int AS n FROM ${this.table} WHERE ${where}`, params);
    return res.rows[0].n;
  }

  async exists(filter: Row): Promise<{ _id: string } | null> {
    const params: unknown[] = [];
    const where = buildWhere(filter, params);
    const res = await getPool().query(`SELECT "_id" FROM ${this.table} WHERE ${where} LIMIT 1`, params);
    return res.rows[0] ?? null;
  }

  /** Tasodifiy n qator (Mongo'dagi $sample o'rniga). Kichik jadvallar uchun. */
  async sample(n: number): Promise<T[]> {
    const res = await getPool().query(`SELECT * FROM ${this.table} ORDER BY random() LIMIT ${Math.max(0, Math.trunc(n))}`);
    return res.rows as T[];
  }

  /** Maydon bo'yicha guruhlab sanash, ko'pdan kamga ($group + $sum: 1 o'rniga). */
  async countBy(field: string, filter?: Row): Promise<Array<{ value: string | null; count: number }>> {
    const params: unknown[] = [];
    const where = buildWhere(filter, params);
    const col = quote(field);
    const res = await getPool().query(
      `SELECT ${col} AS value, count(*)::int AS count FROM ${this.table} WHERE ${where} GROUP BY ${col} ORDER BY count DESC`,
      params,
    );
    return res.rows;
  }

  /** Doc.save() — faqat o'zgargan maydonlar yoziladi. */
  async __save(data: Row, dirty: Set<string>): Promise<void> {
    if (dirty.size === 0) return;
    const patch: Row = {};
    const cleared: Row = {};
    for (const k of dirty) {
      if (data[k] === undefined) cleared[k] = '';
      else patch[k] = data[k];
    }
    const params: unknown[] = [];
    const set = buildSet({ $set: patch, $unset: cleared }, params, this.ts, this.json);
    params.push(data._id);
    const res = await getPool().query(`UPDATE ${this.table} SET ${set} WHERE "_id" = $${params.length} RETURNING *`, params);
    dirty.clear();
    const row = res.rows[0];
    if (row) for (const [k, v] of Object.entries(row)) data[k] = v;
  }
}

export function defineModel<T extends Row = Row>(table: string, opts?: ModelOptions): Model<T> {
  return new Model<T>(table, opts);
}

// Server-side pagination (docs/api-contract.md "Pagination"). Every paginated list answers
//   { items: [...], pagination: { page, limit, totalItems, totalPages, hasNextPage, hasPreviousPage, total } }
// `total` repeats `totalItems` for older clients and is deprecated. Defaults: page 1, limit 20; limit at most 100.
// Routes validate ?page and ?limit with the zod fragments in validators/schemas.js (400 VALIDATION_ERROR when invalid); getPagination
// is the second line of defence and never lets an unvalidated value through (it clamps).
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_PAGE = 1000000;

const toInt = (v) => { const n = Number(v); return v !== undefined && v !== null && v !== '' && Number.isInteger(n) ? n : NaN; };

function getPagination(query = {}, defaultLimit = DEFAULT_LIMIT) {
  const p = toInt(query.page); const l = toInt(query.limit);
  const page = Number.isNaN(p) ? 1 : Math.min(MAX_PAGE, Math.max(1, p));
  const limit = Number.isNaN(l) ? defaultLimit : Math.min(MAX_LIMIT, Math.max(1, l));
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

function paginated(items, totalItems, { page, limit }) {
  const totalPages = Math.ceil(totalItems / limit); // 0 when there is nothing to show
  return { items, pagination: { page, limit, totalItems, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1, total: totalItems } };
}

// A sort that is not unique (many rows with the same createdAt) can repeat or skip rows between pages: add the id as the last tie-breaker.
const stableOrder = (orderBy) => {
  const list = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return list.some((o) => Object.prototype.hasOwnProperty.call(o, 'id')) ? list : [...list, { id: 'asc' }];
};

/**
 * One page of a Prisma query plus the total, using database-level skip/take and a COUNT with the same `where`
 * (so every access rule and filter in `where` is applied before the page is cut).
 * @param delegate  prisma.<model>   @param args  { where, orderBy, include|select }   @param query  { page, limit }
 * @param opts      { map(item) → item, defaultLimit }
 */
async function paginateQuery(delegate, args, query, { map, defaultLimit } = {}) {
  const pg = getPagination(query, defaultLimit);
  const [rows, total] = await Promise.all([
    delegate.findMany({ ...args, orderBy: stableOrder(args.orderBy), skip: pg.skip, take: pg.take }),
    delegate.count({ where: args.where }),
  ]);
  return paginated(map ? rows.map(map) : rows, total, pg);
}

module.exports = { getPagination, paginated, paginateQuery, stableOrder, DEFAULT_LIMIT, MAX_LIMIT, MAX_PAGE };

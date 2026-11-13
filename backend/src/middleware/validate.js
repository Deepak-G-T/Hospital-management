const ApiError = require('../utils/ApiError');

// Validates req.body / req.query / req.params with zod schemas and replaces them with parsed values
const validate = (schemas) => Object.assign((req, res, next) => {
  try {
    for (const key of ['params', 'query', 'body']) {
      if (!schemas[key]) continue;
      const result = schemas[key].safeParse(req[key] ?? {});
      if (!result.success) {
        const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
        throw ApiError.validation(details[0] ? `${details[0].field ? `${details[0].field}: ` : ''}${details[0].message}` : 'Validation failed', details);
      }
      req[key] = result.data;
    }
    next();
  } catch (err) {
    next(err);
  }
}, { validates: Object.keys(schemas), schemas }); // `validates` / `schemas` are read by the API inventory and the OpenAPI generator only

module.exports = validate;

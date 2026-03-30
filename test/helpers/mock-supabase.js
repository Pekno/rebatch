/**
 * Creates a mock Supabase client with chainable query builder.
 *
 * Usage:
 *   const mock = createMockClient([
 *     { data: [...], error: null, count: 5 },   // response for 1st awaited query
 *     { data: null, error: null },               // response for 2nd awaited query
 *   ]);
 *
 * Each `await supabase.from(...).select(...)...` consumes the next response from the queue.
 * `mock.calls` records every method invocation for assertions.
 */
export function createMockClient(responseQueue = []) {
  const calls = [];
  let queueIdx = 0;

  function dequeue() {
    return responseQueue[queueIdx++] || { data: null, error: null, count: 0 };
  }

  function makeChain() {
    const obj = {};

    // Chainable methods — return a new chain
    for (const m of ['select', 'update', 'delete', 'eq', 'in', 'is', 'not', 'contains', 'order', 'range', 'limit']) {
      obj[m] = (...args) => {
        calls.push({ method: m, args });
        return makeChain();
      };
    }

    // Terminal methods — return the response directly (not thenable)
    obj.maybeSingle = (...args) => {
      calls.push({ method: 'maybeSingle', args });
      return dequeue();
    };
    obj.single = (...args) => {
      calls.push({ method: 'single', args });
      return dequeue();
    };

    // insert is terminal (no further chaining in the codebase)
    obj.insert = (data) => {
      calls.push({ method: 'insert', args: [data] });
      return dequeue();
    };

    // Make the chain thenable so `await ...chain` works
    obj.then = (resolve, reject) => {
      try {
        resolve(dequeue());
      } catch (e) {
        reject(e);
      }
    };

    return obj;
  }

  return {
    from: (table) => {
      calls.push({ method: 'from', args: [table] });
      return makeChain();
    },
    calls,
    reset: () => {
      calls.length = 0;
      queueIdx = 0;
    },
  };
}

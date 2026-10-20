(function attachMemePerpEngine(globalScope) {
  'use strict';

  class MemePerpEngineClient {
    constructor(options = {}) {
      if (typeof options.request !== 'function') {
        throw new Error('MemePerpEngineClient requires a request function');
      }
      this.request = options.request;
      this.mode = String(options.mode || 'simulation');
    }

    getAccountState() {
      return this.request('/account/state');
    }

    getQuote(order) {
      return this.request('/trade/quote', {
        method: 'POST',
        body: JSON.stringify(order),
      });
    }

    openPosition(order) {
      return this.request('/positions/open', {
        method: 'POST',
        body: JSON.stringify(order),
      });
    }

    closePosition(positionId, close = {}) {
      return this.request(`/positions/${encodeURIComponent(positionId)}/close`, {
        method: 'POST',
        body: JSON.stringify(close),
      });
    }

    cancelOrder(orderId) {
      return this.request(`/orders/${encodeURIComponent(orderId)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    }

    updatePositionTpSl(positionId, tpSl = {}) {
      return this.request('/position/tpsl', {
        method: 'POST',
        body: JSON.stringify({ positionId, ...tpSl }),
      });
    }

    liquidatePosition(positionId, liquidation = {}) {
      return this.request(`/positions/${encodeURIComponent(positionId)}/liquidate`, {
        method: 'POST',
        body: JSON.stringify(liquidation),
      });
    }

    addBalance(amountSol, auditSig) {
      return this.request('/balance/add', {
        method: 'POST',
        body: JSON.stringify({ amountSol, auditSig }),
      });
    }

    resetAccount() {
      return this.request('/account/reset', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    }
  }

  globalScope.MemePerpEngineClient = MemePerpEngineClient;
})(window);
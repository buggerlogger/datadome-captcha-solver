export function postSolveUrl(dd, targetUrl, referrer = '') {
  try {
    let originalReferrer = referrer;
    if (!originalReferrer && dd.rr) originalReferrer = decodeURIComponent(dd.rr);
    const cur = new URL(targetUrl);
    const currentBaseUrl = cur.origin + cur.pathname;
    const referrerBaseUrl = String(referrer).split('?')[0].split('#')[0];
    if (dd.rr == null || referrerBaseUrl === currentBaseUrl) return { url: targetUrl, branch: 'reload' };
    const newURL = new URL(targetUrl);
    if (newURL.search === '' && dd.qp != null) {
      const qp = new URLSearchParams(decodeURIComponent(dd.qp));
      qp.set('dd_referrer', originalReferrer);
      newURL.search = qp.toString();
    } else {
      newURL.searchParams.set('dd_referrer', originalReferrer);
    }
    return { url: newURL.toString(), branch: 'href' };
  } catch (_) {
    return { url: targetUrl, branch: 'reload(fallback)' };
  }
}


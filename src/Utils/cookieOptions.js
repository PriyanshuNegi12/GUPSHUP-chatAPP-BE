// secure:true + sameSite:'none' cookies are silently dropped by browsers over
// plain HTTP — including on the socket.io handshake, which reads the same
// cookie header your API calls use. That's the most likely reason your
// message never sent: the socket auth was failing before sendMessage ever ran.
const isProd = process.env.NODE_ENV === 'production';

const authCookieOptions = (maxAgeMs) => ({
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
});

const clearCookieOptions = () => ({
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    expires: new Date(0),
});

module.exports = { authCookieOptions, clearCookieOptions };
// JT808 + RTMP ONLY Version (RTP Removed)
const net = require('net');
const express = require('express');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

const PORT = 7070;        // JT808 TCP
const HTTP_PORT = 3000;   // HTTP for manual trigger
const sessions = {};      // IMEI-to-{ socket, serialNo }

// Replace with your RTMP server IP/Port
const RTMP_URL = 'rtmp://76.13.78.45/live/stream';

// ========================
// Serial Number per IMEI
// ========================
function getNextSerial(imei) {
  if (!sessions[imei]) return 1;
  sessions[imei].serialNo = ((sessions[imei].serialNo || 0) + 1) & 0xffff;
  return sessions[imei].serialNo;
}

// ========================
// RTMP Enable (0x8103)
// ========================
function send8103RTMPEnable(imei) {
  const session = sessions[imei];
  if (!session || !session.socket) return console.log(`❌ No session for IMEI: ${imei}`);
  const socket = session.socket;

  const msgId = Buffer.from([0x81, 0x03]);
  const paramId = Buffer.from([0x00, 0x7A]); // RTMP Enable
  const paramLength = Buffer.from([0x04]);

  const paramValue = Buffer.alloc(4);
  paramValue.writeUInt32BE(1); // Enable RTMP

  const paramCount = Buffer.from([0x01]);
  const paramBody = Buffer.concat([paramCount, paramId, paramLength, paramValue]);

  const serial = getNextSerial(imei);
  const header = createJT808Header(msgId, imei, paramBody.length, serial);
  const rawPacket = Buffer.concat([header, paramBody]);

  const checksum = rawPacket.reduce((sum, byte) => sum ^ byte, 0);

  const finalPacket = Buffer.concat([
    Buffer.from([0x7e]),
    escapeJT808(Buffer.concat([rawPacket, Buffer.from([checksum])])),
    Buffer.from([0x7e])
  ]);

  console.log(`📤 Final 0x8103 RTMP Enable Packet: ${finalPacket.toString("hex")}`);
  socket.write(finalPacket);
}

// ========================
// Start Stream (0x9101)
// ========================
function send9101Command(imei) {
  const session = sessions[imei];
  if (!session || !session.socket) return console.log(`❌ No session for IMEI: ${imei}`);
  const socket = session.socket;

  const msgId = Buffer.from([0x91, 0x01]);

  const ipStr = '76.13.78.45';
  const ipBytes = Buffer.from(ipStr, 'ascii');
  const ipLen = Buffer.from([ipBytes.length]);

  const tcpPort = Buffer.alloc(2);
  tcpPort.writeUInt16BE(1935);

  const udpPort = Buffer.alloc(2);
  udpPort.writeUInt16BE(0);

  const logicChannel = Buffer.from([0x01]);
  const dataType = Buffer.from([0x01]);
  const streamType = Buffer.from([0x02]); // RTMP

  const body = Buffer.concat([
    ipLen, ipBytes,
    tcpPort, udpPort,
    logicChannel, dataType, streamType
  ]);

  const serial = getNextSerial(imei);
  const header = createJT808Header(msgId, imei, body.length, serial);
  const rawPacket = Buffer.concat([header, body]);

  const checksum = rawPacket.reduce((sum, byte) => sum ^ byte, 0);

  const finalPacket = Buffer.concat([
    Buffer.from([0x7e]),
    escapeJT808(Buffer.concat([rawPacket, Buffer.from([checksum])])),
    Buffer.from([0x7e])
  ]);

  console.log(`📤 Final Packet Hex: ${finalPacket.toString('hex')}`);
  socket.write(finalPacket);

  console.log(`📤 Sent 0x9101 RTMP command to ${imei}`);
}

// ========================
// Heartbeat ACK (0x8001 for 0x0002)
// ========================
function send8001HeartbeatAck(socket, terminalId, msgSerialNo) {
  const msgId = Buffer.from([0x80, 0x01]);

  const body = Buffer.concat([
    msgSerialNo,
    Buffer.from([0x00, 0x02]), // responding to heartbeat 0x0002
    Buffer.from([0x00])        // result: success
  ]);

  const header = Buffer.alloc(12);
  header[0] = msgId[0];
  header[1] = msgId[1];
  header[2] = 0x00;
  header[3] = body.length;
  terminalId.copy(header, 4);
  header[10] = 0x00;
  header[11] = 0x01;

  const raw = Buffer.concat([header, body]);
  const checksum = raw.reduce((sum, b) => sum ^ b, 0);

  const finalPacket = Buffer.concat([
    Buffer.from([0x7e]),
    escapeJT808(Buffer.concat([raw, Buffer.from([checksum])])),
    Buffer.from([0x7e])
  ]);

  console.log(`💓 Sent heartbeat ACK: ${finalPacket.toString('hex')}`);
  socket.write(finalPacket);
}

// ========================
// ACK 0x8100
// ========================
function send8100Ack(socket, msg, result = 0x00) {
  const msgId = Buffer.from([0x81, 0x00]);
  const msgSerialNo = msg.slice(msg.length - 5, msg.length - 3);
  const terminalId = msg.slice(4, 10);
  const originalMsgId = Buffer.from([0x01, 0x00]);

  const body = Buffer.concat([
    msgSerialNo,
    originalMsgId,
    Buffer.from([result])
  ]);

  const header = Buffer.alloc(12);
  header[0] = msgId[0];
  header[1] = msgId[1];
  header[2] = 0x00;
  header[3] = body.length;

  terminalId.copy(header, 4);

  header[10] = 0x00;
  header[11] = 0x01;

  const rawPacket = Buffer.concat([header, body]);
  const checksum = rawPacket.reduce((sum, byte) => sum ^ byte, 0);

  const finalPacket = Buffer.concat([
    Buffer.from([0x7e]),
    escapeJT808(Buffer.concat([rawPacket, Buffer.from([checksum])])),
    Buffer.from([0x7e])
  ]);

  console.log(`📤 Final 0x8100 ACK Hex: ${finalPacket.toString('hex')}`);
  socket.write(finalPacket);
}

// ========================
// ACK 0x8001
// ========================
function send8001Ack(socket, msg, serialNoBuf) {
  const msgId = Buffer.from([0x80, 0x01]);
  const terminalId = msg.slice(4, 10);

  const body = Buffer.concat([
    serialNoBuf,
    Buffer.from([0x01, 0x02]),
    Buffer.from([0x00])
  ]);

  const header = Buffer.alloc(12);
  header[0] = msgId[0];
  header[1] = msgId[1];
  header[2] = 0x00;
  header[3] = body.length;

  terminalId.copy(header, 4);

  header[10] = 0x00;
  header[11] = 0x01;

  const raw = Buffer.concat([header, body]);
  const checksum = raw.reduce((sum, b) => sum ^ b, 0);

  const finalPacket = Buffer.concat([
    Buffer.from([0x7e]),
    escapeJT808(Buffer.concat([raw, Buffer.from([checksum])])),
    Buffer.from([0x7e])
  ]);

  console.log(`📤 Final 0x8001 ACK Hex: ${finalPacket.toString("hex")}`);
  socket.write(finalPacket);
}

// ========================
// Helpers
// ========================
function createJT808Header(msgId, imei, bodyLength, serialNo) {
  const header = Buffer.alloc(12);

  header[0] = msgId[0];
  header[1] = msgId[1];
  header[2] = (bodyLength >> 8) & 0xff;
  header[3] = bodyLength & 0xff;

  const imeiStr = imei.padStart(12, '0');
  const imeiBcd = bcdEncode(imeiStr);

  imeiBcd.copy(header, 4, 0, 6);

  header[10] = (serialNo >> 8) & 0xff;
  header[11] = serialNo & 0xff;

  return header;
}

function bcdEncode(numStr) {
  const buf = Buffer.alloc(Math.ceil(numStr.length / 2));

  for (let i = 0; i < numStr.length; i += 2) {
    const high = parseInt(numStr[i], 10);
    const low = parseInt(numStr[i + 1] || '0', 10);
    buf[i / 2] = (high << 4) | low;
  }

  return buf;
}

function escapeJT808(buffer) {
  const ESCAPE = {
    0x7e: Buffer.from([0x7d, 0x02]),
    0x7d: Buffer.from([0x7d, 0x01])
  };

  const escaped = [];

  for (let byte of buffer) {
    if (ESCAPE[byte]) escaped.push(...ESCAPE[byte]);
    else escaped.push(byte);
  }

  return Buffer.from(escaped);
}

// ========================
// Split multi-frame TCP data into individual JT808 packets
// ========================
function splitJT808Packets(data) {
  const packets = [];
  let start = -1;

  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x7e) {
      if (start === -1) {
        start = i;
      } else {
        packets.push(data.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return packets;
}

// ========================
// Handle a single parsed JT808 packet
// ========================
function handlePacket(socket, packet) {
  if (packet.length < 4) return;

  const msgId = packet.slice(1, 3).toString('hex');

  function extractIMEIFromPacket(p) {
    return p.slice(5, 11).toString('hex');
  }

  // Heartbeat 0x0002 — must ACK or device disconnects
  if (msgId === '0002') {
    const terminalId = packet.slice(5, 11);
    const msgSerialNo = packet.slice(10, 12);
    console.log(`💓 Heartbeat received, sending ACK`);
    send8001HeartbeatAck(socket, terminalId, msgSerialNo);
    return;
  }

  // Location report 0x0200 — ACK to keep device happy
  if (msgId === '0200') {
    const terminalId = packet.slice(5, 11);
    const msgSerialNo = packet.slice(10, 12);
    const imei = terminalId.toString('hex');
    console.log(`📍 Location report from ${imei}`);

    const ackBody = Buffer.concat([
      msgSerialNo,
      Buffer.from([0x02, 0x00]),
      Buffer.from([0x00])
    ]);
    const ackHeader = Buffer.alloc(12);
    ackHeader[0] = 0x80; ackHeader[1] = 0x01;
    ackHeader[2] = 0x00; ackHeader[3] = ackBody.length;
    terminalId.copy(ackHeader, 4);
    ackHeader[10] = 0x00; ackHeader[11] = 0x01;

    const raw = Buffer.concat([ackHeader, ackBody]);
    const checksum = raw.reduce((s, b) => s ^ b, 0);
    const finalPacket = Buffer.concat([
      Buffer.from([0x7e]),
      escapeJT808(Buffer.concat([raw, Buffer.from([checksum])])),
      Buffer.from([0x7e])
    ]);
    socket.write(finalPacket);
    return;
  }

  // Terminal general response 0x0001 — device ACKing our commands
  if (msgId === '0001') {
    const terminalId = packet.slice(5, 11).toString('hex');
    const respondedMsgId = packet.slice(13, 15).toString('hex');
    const result = packet[15];
    console.log(`✅ Device ACK 0x0001 from ${terminalId}: responded to 0x${respondedMsgId}, result=${result}`);
    return;
  }

  // Registration 0x0100
  if (msgId === '0100') {
    const imei = extractIMEIFromPacket(packet);
    if (!imei) return console.log("❌ IMEI extraction failed");

    console.log(`📱 Extracted IMEI ${imei}`);

    // Only register if not already streaming on a live socket
    const existing = sessions[imei];
    if (existing && existing.socket && !existing.socket.destroyed) {
      console.log(`⚠️ IMEI ${imei} re-registered, replacing old socket`);
      existing.socket.destroy();
    }

    sessions[imei] = { socket, serialNo: 10 };
    console.log(`✅ Device registered with IMEI: ${imei}`);

    const Qr = `rtmp://76.13.78.45/live/${imei}`;
    console.log(`📱 RTMP URL: ${Qr}`);
    QRCode.toDataURL(Qr, (err, url) => {
      if (err) console.error('❌ Failed to generate QR code:', err);
      else console.log(`🧾 QR Code generated for ${imei}`);
    });

    send8100Ack(socket, packet);
    return;
  }

  // Auth 0x0102
  if (msgId === '0102') {
    const imei = extractIMEIFromPacket(packet);
    if (!imei) return console.log("❌ IMEI extraction failed");

    console.log(`📱 Auth from IMEI ${imei}`);

    // Update socket in case it changed (reconnect)
    if (!sessions[imei]) {
      sessions[imei] = { socket, serialNo: 10 };
    } else {
      sessions[imei].socket = socket;
    }

    console.log(`✅ Device authenticated with IMEI: ${imei}`);

    const Qr = `rtmp://76.13.78.45/live/${imei}`;
    console.log(`📱 RTMP URL: ${Qr}`);
    QRCode.toDataURL(Qr, (err, url) => {
      if (err) console.error('❌ Failed to generate QR code:', err);
      else console.log(`🧾 QR Code generated for ${imei}`);
    });

    const serialNo = packet.slice(packet.length - 5, packet.length - 3);
    send8001Ack(socket, packet, serialNo);

    // Small delay to let ACK arrive before sending commands
    setTimeout(() => {
      send8103RTMPEnable(imei);
      setTimeout(() => send9101Command(imei), 1500);
    }, 500);

    return;
  }

  // Stream status 0x9102 response
  if (msgId === '0001') {
    console.log(`📡 Stream status response received`);
    return;
  }

  console.log(`ℹ️ Unhandled msgId: 0x${msgId}`);
}

// ========================
// TCP Server
// ========================
const server = net.createServer((socket) => {
  console.log(`📡 Device Connected: ${socket.remoteAddress}:${socket.remotePort}`);

  // Per-socket receive buffer to handle partial packets
  let recvBuffer = Buffer.alloc(0);

  socket.on('data', (data) => {
    console.log(`📥 Received Hex: ${data.toString('hex')}`);

    // Append to buffer and split on 0x7e boundaries
    recvBuffer = Buffer.concat([recvBuffer, data]);

    const packets = splitJT808Packets(recvBuffer);

    // Keep any trailing incomplete data in buffer
    const lastBoundary = recvBuffer.lastIndexOf(0x7e);
    if (lastBoundary !== -1 && lastBoundary < recvBuffer.length - 1) {
      recvBuffer = recvBuffer.slice(lastBoundary + 1);
    } else {
      recvBuffer = Buffer.alloc(0);
    }

    for (const packet of packets) {
      handlePacket(socket, packet);
    }
  });

  socket.on('close', () => {
    console.log(`🔌 Socket closed: ${socket.remoteAddress}:${socket.remotePort}`);
    // Remove stale session entries for this socket
    for (const imei of Object.keys(sessions)) {
      if (sessions[imei].socket === socket) {
        console.log(`🗑️ Cleared session for IMEI: ${imei}`);
        delete sessions[imei];
      }
    }
  });

  socket.on('error', (err) => {
    console.log(`⚠️ Socket error: ${err.message}`);
  });

  // Keep socket alive at TCP level
  socket.setKeepAlive(true, 30000);
});

server.listen(PORT, () => {
  console.log(`🚀 JT808 TCP Server listening on port ${PORT}`);
});

// ========================
// HTTP Trigger
// ========================
const app = express();

app.get('/start/:imei', (req, res) => {
  const imei = req.params.imei;
  send9101Command(imei);
  res.send(`✅ Sent RTMP 0x9101 to ${imei}`);
});

app.get('/status', (req, res) => {
  const status = Object.keys(sessions).map(imei => ({
    imei,
    connected: !sessions[imei].socket.destroyed,
    serialNo: sessions[imei].serialNo
  }));
  res.json(status);
});

app.listen(HTTP_PORT, () => {
  console.log(`🌐 HTTP Server listening on port ${HTTP_PORT}`);
});

//Ashish code

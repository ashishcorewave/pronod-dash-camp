// JT808 + RTMP ONLY Version (RTP Removed)
const net = require('net');
const express = require('express');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

const PORT = 7070;        // JT808 TCP
const HTTP_PORT = 3000;   // HTTP for manual trigger
const sessions = {};      // IMEI-to-socket

// Replace with your RTMP server IP/Port
const RTMP_URL = 'rtmp://76.13.78.45/live/stream';

// ========================
// RTMP Enable (0x8103)
// ========================
function send8103RTMPEnable(imei) {
  const socket = sessions[imei];
  if (!socket) return console.log(`❌ No session for IMEI: ${imei}`);

  const msgId = Buffer.from([0x81, 0x03]);
  const paramId = Buffer.from([0x00, 0x7A]); // RTMP Enable
  const paramLength = Buffer.from([0x04]);

  const paramValue = Buffer.alloc(4);
  paramValue.writeUInt32BE(1); // Enable RTMP

  const paramCount = Buffer.from([0x01]);
  const paramBody = Buffer.concat([paramCount, paramId, paramLength, paramValue]);

  const header = createJT808Header(msgId, imei, paramBody.length, 2);
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
  const socket = sessions[imei];
  if (!socket) return console.log(`❌ No session for IMEI: ${imei}`);

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

  const header = createJT808Header(msgId, imei, body.length, 1);
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
// TCP Server
// ========================
const server = net.createServer((socket) => {
  console.log(`📡 Device Connected: ${socket.remoteAddress}:${socket.remotePort}`);

  socket.on('data', (data) => {
    console.log(`📥 Received Hex: ${data.toString('hex')}`);

    const msgId = data.slice(1, 3).toString('hex');

    function extractIMEIFromPacket(packet) {
      const imeiBuf = packet.slice(5, 11);
      return imeiBuf.toString('hex');
    }

    if (msgId === '0100' || msgId === '0102') {
      const imei = extractIMEIFromPacket(data);

      console.log(`📱 Extracted IMEI ${imei}`);

      const Qr = `rtmp://76.13.78.45/live/${imei}`;
      console.log(`📱 RTMP URL: ${Qr}`);

      QRCode.toDataURL(Qr, function (err, url) {
        if (err) {
          console.error('❌ Failed to generate QR code:', err);
        } else {
          console.log(`🧾 QR Code (base64): ${url}`);
        }
      });

      if (!imei) return console.log("❌ IMEI extraction failed");

      sessions[imei] = socket;
      console.log(`✅ Device connected with IMEI: ${imei}`);

      if (msgId === '0100') {
        send8100Ack(socket, data);
      }

      if (msgId === '0102') {
        const serialNo = data.slice(data.length - 5, data.length - 3);
        send8001Ack(socket, data, serialNo);

        send8103RTMPEnable(imei);
        setTimeout(() => send9101Command(imei), 1000);
      }
    }
  });
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

app.listen(HTTP_PORT, () => {
  console.log(`🌐 HTTP Server listening on port ${HTTP_PORT}`);
});
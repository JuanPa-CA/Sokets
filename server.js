const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- CONFIGURACION Y DB ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sockets_db';
const PORT = process.env.PORT || 3002;

mongoose.connect(MONGO_URI)
    .then(() => console.log('DB: Conectada'))
    .catch(err => console.error('DB: Error', err));

// --- MODELOS ---
const userSchema = new mongoose.Schema({
    nickname: { type: String, unique: true, required: true },
    socketId: String,
    lastLogin: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const votoSchema = new mongoose.Schema({
    sala: String,
    opcion: String,
    nickname: String, 
    fecha: { type: Date, default: Date.now }
});
const Voto = mongoose.model('Voto', votoSchema);

// --- ESTADO GLOBAL ---
const encuestas = {
    'programacion': {
        pregunta: 'Lenguaje favorito',
        opciones: { 'JavaScript': 0, 'Python': 0, 'Java': 0, 'C#': 0 },
        votosRegistrados: new Set()
    },
    'videojuegos': {
        pregunta: 'Juego favorito',
        opciones: { 'Minecraft': 0, 'Fortnite': 0, 'Roblox': 0 },
        votosRegistrados: new Set()
    },
    'deportes': {
        pregunta: 'Deporte favorito',
        opciones: { 'Futbol': 0, 'Basquet': 0, 'Tenis': 0 },
        votosRegistrados: new Set()
    }
};

const chatHistorial = {};
let colaEspera = [];
let partidas = {};

// --- UTILIDADES ---
async function sincronizarMemoria() {
    try {
        const votos = await Voto.find();
        votos.forEach(v => {
            if (encuestas[v.sala] && encuestas[v.sala].opciones[v.opcion] !== undefined) {
                encuestas[v.sala].opciones[v.opcion]++;
                encuestas[v.sala].votosRegistrados.add(v.nickname);
            }
        });
        console.log(`Sync: ${votos.length} votos`);
    } catch (err) {
        console.error('Sync Error:', err);
    }
}

function updateRoomCount(sala) {
    if (!sala) return;
    const count = io.sockets.adapter.rooms.get(sala)?.size || 0;
    io.to(sala).emit('usuarios:conteo', count);
}

function calcularGanadorJuego(j1, j2) {
    if (j1.eleccion === j2.eleccion) return 'Empate';
    const reglas = { 'Piedra': 'Tijeras', 'Papel': 'Piedra', 'Tijeras': 'Papel' };
    return reglas[j1.eleccion] === j2.eleccion ? j1.nickname : j2.nickname;
}

// --- SERVIDOR ---
sincronizarMemoria();
app.use(express.static('public'));

io.on('connection', (socket) => {
    let currentRoom = null;

    // Autenticacion
    socket.on('auth:login', async (nickname) => {
        try {
            await User.findOneAndUpdate(
                { nickname },
                { socketId: socket.id, lastLogin: Date.now() },
                { upsert: true }
            );
            socket.nickname = nickname;
            socket.emit('auth:success', { nickname });
        } catch (err) {
            socket.emit('auth:error', 'Error al iniciar sesion');
        }
    });

    // Gestion de Salas
    socket.on('sala:unirse', (sala) => {
        if (!socket.nickname) return;
        
        if (currentRoom) {
            socket.leave(currentRoom);
            const prevRoom = currentRoom;
            setTimeout(() => updateRoomCount(prevRoom), 100);
        }

        if (encuestas[sala]) {
            socket.join(sala);
            currentRoom = sala;
            
            socket.emit('encuesta:estado', {
                pregunta: encuestas[sala].pregunta,
                opciones: encuestas[sala].opciones,
                hasVoted: encuestas[sala].votosRegistrados.has(socket.nickname)
            });

            socket.emit('chat:historial', chatHistorial[sala] || []);
            updateRoomCount(sala);
        }
    });

    // Encuesta
    socket.on('encuesta:votar', async ({ sala, opcion }) => {
        const encuesta = encuestas[sala];
        if (!encuesta || !socket.nickname || encuesta.votosRegistrados.has(socket.nickname)) {
            return socket.emit('encuesta:error', 'Voto invalido o ya registrado');
        }

        if (encuesta.opciones[opcion] !== undefined) {
            try {
                await new Voto({ sala, opcion, nickname: socket.nickname }).save();
                encuesta.opciones[opcion]++;
                encuesta.votosRegistrados.add(socket.nickname);
                
                // Notificar a todos los de la sala el nuevo resultado
                // Pero cada cliente decide si mostrar el botón o la barra basado en su propio estado local o emitido
                io.to(sala).emit('encuesta:resultado', {
                    pregunta: encuesta.pregunta,
                    opciones: encuesta.opciones,
                    lastVoter: socket.nickname // Útil para que el que votó sepa que fue él
                });
            } catch (err) {
                console.error('Voto Error:', err);
            }
        }
    });

    // Chat
    socket.on('chat:mensaje', ({ sala, texto }) => {
        if (!socket.nickname || !texto.trim()) return;
        const msg = {
            usuario: socket.nickname,
            texto: texto.trim(),
            fecha: new Date().toLocaleTimeString()
        };
        chatHistorial[sala] = chatHistorial[sala] || [];
        chatHistorial[sala].push(msg);
        if (chatHistorial[sala].length > 50) chatHistorial[sala].shift();
        io.to(sala).emit('chat:mensaje', msg);
    });

    // Reacciones
    socket.on('reaccion:enviar', ({ sala, emoji }) => {
        if (socket.nickname) io.to(sala).emit('reaccion:mostrar', emoji);
    });

    // Juego
    socket.on('juego:buscar', () => {
        if (!socket.nickname || colaEspera.some(s => s.id === socket.id)) return;
        colaEspera.push(socket);
        if (colaEspera.length >= 2) {
            const p1 = colaEspera.shift();
            const p2 = colaEspera.shift();
            const partidaId = `game_${Date.now()}`;
            p1.join(partidaId);
            p2.join(partidaId);
            partidas[partidaId] = {
                jugadores: [
                    { id: p1.id, nickname: p1.nickname, eleccion: null },
                    { id: p2.id, nickname: p2.nickname, eleccion: null }
                ]
            };
            io.to(partidaId).emit('juego:inicio', {
                partidaId,
                oponente1: p1.nickname,
                oponente2: p2.nickname
            });
        } else {
            socket.emit('juego:esperando', 'Buscando oponente...');
        }
    });

    socket.on('juego:eleccion', ({ partidaId, eleccion }) => {
        const partida = partidas[partidaId];
        if (!partida) return;
        const j = partida.jugadores.find(p => p.id === socket.id);
        if (j && !j.eleccion) {
            j.eleccion = eleccion;
            if (partida.jugadores.every(p => p.eleccion)) {
                const [j1, j2] = partida.jugadores;
                const ganador = calcularGanadorJuego(j1, j2);
                io.to(partidaId).emit('juego:resultado', {
                    elecciones: { [j1.nickname]: j1.eleccion, [j2.nickname]: j2.eleccion },
                    ganador
                });
                setTimeout(() => delete partidas[partidaId], 5000);
            } else {
                socket.emit('juego:esperando_oponente', 'Esperando eleccion oponente...');
            }
        }
    });

    // Desconexion
    socket.on('disconnecting', () => {
        colaEspera = colaEspera.filter(s => s.id !== socket.id);
        socket.rooms.forEach(room => {
            if (room !== socket.id) {
                setTimeout(() => updateRoomCount(room), 100);
            }
        });
    });
});

// --- REINICIO AUTOMÁTICO DE ENCUESTAS (Cada 24 horas) ---
setInterval(async () => {
    try {
        await Voto.deleteMany({}); // Limpiar DB
        for (const sala in encuestas) {
            for (const opcion in encuestas[sala].opciones) {
                encuestas[sala].opciones[opcion] = 0;
            }
            encuestas[sala].votosRegistrados.clear();
            
            // Notificar a todos en la sala del reinicio
            io.to(sala).emit('encuesta:estado', {
                pregunta: encuestas[sala].pregunta,
                opciones: encuestas[sala].opciones,
                hasVoted: false
            });
        }
        console.log('Encuestas: Reiniciadas por cron (24 horas)');
    } catch (err) {
        console.error('Error cron reinicio:', err);
    }
}, 86400000); // 24 * 60 * 60 * 1000 ms

server.listen(PORT, () => console.log(`Run: http://localhost:${PORT}`));

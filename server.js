const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const servidor = http.createServer(app);
const io = new Server(servidor);

// --- CONFIGURACIÓN Y BASE DE DATOS ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sockets_db';
const PUERTO = process.env.PORT || 3002;

mongoose.connect(MONGO_URI)
    .then(() => console.log('Base de Datos: Conectada'))
    .catch(error => console.error('Base de Datos: Error', error));

// --- MODELOS ---
const esquemaUsuario = new mongoose.Schema({
    apodo: { type: String, unique: true, required: true },
    idSocket: String,
    ultimoAcceso: { type: Date, default: Date.now }
});
const Usuario = mongoose.model('Usuario', esquemaUsuario);

const esquemaVoto = new mongoose.Schema({
    sala: String,
    opcion: String,
    apodo: String, 
    fecha: { type: Date, default: Date.now }
});
const Voto = mongoose.model('Voto', esquemaVoto);

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

const historialChat = {};
let colaEspera = [];
let partidas = {};

// --- UTILIDADES ---
async function sincronizarMemoria() {
    try {
        const votos = await Voto.find();
        votos.forEach(v => {
            if (encuestas[v.sala] && encuestas[v.sala].opciones[v.opcion] !== undefined) {
                encuestas[v.sala].opciones[v.opcion]++;
                encuestas[v.sala].votosRegistrados.add(v.apodo);
            }
        });
        console.log(`Sincronización: ${votos.length} votos cargados`);
    } catch (error) {
        console.error('Error de Sincronización:', error);
    }
}

function actualizarConteoUsuarios(sala) {
    if (!sala) return;
    const cantidad = io.sockets.adapter.rooms.get(sala)?.size || 0;
    io.to(sala).emit('usuarios:conteo', cantidad);
}

function calcularGanadorJuego(jugador1, jugador2) {
    if (jugador1.eleccion === jugador2.eleccion) return 'Empate';
    const reglas = { 'Piedra': 'Tijeras', 'Papel': 'Piedra', 'Tijeras': 'Papel' };
    return reglas[jugador1.eleccion] === jugador2.eleccion ? jugador1.apodo : jugador2.apodo;
}

// --- SERVIDOR ---
sincronizarMemoria();
app.use(express.static('public'));

io.on('connection', (socket) => {
    let salaActual = null;

    // Autenticación
    socket.on('autenticacion:iniciar', async (apodo) => {
        try {
            await Usuario.findOneAndUpdate(
                { apodo },
                { idSocket: socket.id, ultimoAcceso: Date.now() },
                { upsert: true }
            );
            socket.apodo = apodo;
            socket.emit('autenticacion:exito', { apodo });
        } catch (error) {
            socket.emit('autenticacion:error', 'Error al iniciar sesión');
        }
    });

    // Gestión de Salas
    socket.on('sala:unirse', (sala) => {
        if (!socket.apodo) return;
        
        if (salaActual) {
            socket.leave(salaActual);
            const salaPrevia = salaActual;
            setTimeout(() => actualizarConteoUsuarios(salaPrevia), 100);
        }

        if (encuestas[sala]) {
            socket.join(sala);
            salaActual = sala;
            
            socket.emit('encuesta:estado', {
                pregunta: encuestas[sala].pregunta,
                opciones: encuestas[sala].opciones,
                yaVoto: encuestas[sala].votosRegistrados.has(socket.apodo)
            });

            socket.emit('chat:historial', historialChat[sala] || []);
            actualizarConteoUsuarios(sala);
        }
    });

    // Encuesta
    socket.on('encuesta:votar', async ({ sala, opcion }) => {
        const encuesta = encuestas[sala];
        if (!encuesta || !socket.apodo || encuesta.votosRegistrados.has(socket.apodo)) {
            return socket.emit('encuesta:error', 'Voto inválido o ya registrado');
        }

        if (encuesta.opciones[opcion] !== undefined) {
            try {
                await new Voto({ sala, opcion, apodo: socket.apodo }).save();
                encuesta.opciones[opcion]++;
                encuesta.votosRegistrados.add(socket.apodo);
                
                io.to(sala).emit('encuesta:resultado', {
                    pregunta: encuesta.pregunta,
                    opciones: encuesta.opciones,
                    ultimoVotante: socket.apodo
                });
            } catch (error) {
                console.error('Error al Votar:', error);
            }
        }
    });

    // Chat
    socket.on('chat:mensaje', ({ sala, texto }) => {
        if (!socket.apodo || !texto.trim()) return;
        const mensaje = {
            usuario: socket.apodo,
            texto: texto.trim(),
            fecha: new Date().toLocaleTimeString()
        };
        historialChat[sala] = historialChat[sala] || [];
        historialChat[sala].push(mensaje);
        if (historialChat[sala].length > 50) historialChat[sala].shift();
        io.to(sala).emit('chat:mensaje', mensaje);
    });

    // Reacciones
    socket.on('reaccion:enviar', ({ sala, emoji }) => {
        if (socket.apodo) io.to(sala).emit('reaccion:mostrar', emoji);
    });

    // Juego
    socket.on('juego:buscar', () => {
        if (!socket.apodo || colaEspera.some(s => s.id === socket.id)) return;
        colaEspera.push(socket);
        if (colaEspera.length >= 2) {
            const jugador1 = colaEspera.shift();
            const jugador2 = colaEspera.shift();
            const idPartida = `partida_${Date.now()}`;
            jugador1.join(idPartida);
            jugador2.join(idPartida);
            partidas[idPartida] = {
                jugadores: [
                    { id: jugador1.id, apodo: jugador1.apodo, eleccion: null },
                    { id: jugador2.id, apodo: jugador2.apodo, eleccion: null }
                ]
            };
            io.to(idPartida).emit('juego:inicio', {
                idPartida,
                oponente1: jugador1.apodo,
                oponente2: jugador2.apodo
            });
        } else {
            socket.emit('juego:esperando', 'Buscando oponente...');
        }
    });

    socket.on('juego:eleccion', ({ idPartida, eleccion }) => {
        const partida = partidas[idPartida];
        if (!partida) return;
        const jugador = partida.jugadores.find(p => p.id === socket.id);
        if (jugador && !jugador.eleccion) {
            jugador.eleccion = eleccion;
            if (partida.jugadores.every(p => p.eleccion)) {
                const [j1, j2] = partida.jugadores;
                const ganador = calcularGanadorJuego(j1, j2);
                io.to(idPartida).emit('juego:resultado', {
                    elecciones: { [j1.apodo]: j1.eleccion, [j2.apodo]: j2.eleccion },
                    ganador
                });
                setTimeout(() => delete partidas[idPartida], 5000);
            } else {
                socket.emit('juego:esperando_oponente', 'Esperando elección del oponente...');
            }
        }
    });

    // Desconexión
    socket.on('disconnect', async () => {
        if (socket.apodo) {
            try {
                // Limpiamos el idSocket para saber que el usuario ya no está activo
                await Usuario.findOneAndUpdate({ apodo: socket.apodo }, { idSocket: null });
            } catch (error) {
                console.error('Error al limpiar sesión en DB:', error);
            }
        }
    });

    socket.on('disconnecting', () => {
        colaEspera = colaEspera.filter(s => s.id !== socket.id);
        socket.rooms.forEach(sala => {
            if (sala !== socket.id) {
                setTimeout(() => actualizarConteoUsuarios(sala), 100);
            }
        });
    });
});

servidor.listen(PUERTO, () => console.log(`Servidor corriendo en: http://localhost:${PUERTO}`));

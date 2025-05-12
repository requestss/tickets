require('dotenv').config();
const { 
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
  ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits,
  SlashCommandBuilder, Routes
} = require('discord.js');
const { REST } = require('@discordjs/rest');
const Database = require('better-sqlite3');
const { createTranscript } = require('discord-html-transcripts');

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Setup SQLite database
const db = new Database('./tickets.sqlite');
db.pragma('journal_mode = WAL');

// Create tables if they don't exist
db.prepare(`
  CREATE TABLE IF NOT EXISTS config (
    guildId TEXT PRIMARY KEY,
    supportRole TEXT,
    closedCategory TEXT,
    logChannel TEXT,
    panelColor TEXT DEFAULT '#FFC0CB'
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS tickets (
    channelId TEXT PRIMARY KEY,
    guildId TEXT,
    ownerId TEXT,
    panelName TEXT,
    status TEXT DEFAULT 'open',
    createdAt INTEGER DEFAULT (strftime('%s', 'now')),
    closedAt INTEGER
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS ticket_members (
    channelId TEXT,
    userId TEXT,
    PRIMARY KEY (channelId, userId)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS panels (
    guildId TEXT,
    panelName TEXT,
    channelId TEXT,
    title TEXT DEFAULT 'Support Tickets',
    description TEXT DEFAULT 'Click the button below to create a new ticket!',
    imageUrl TEXT,
    PRIMARY KEY (guildId, panelName)
  )
`).run();

// Register slash commands
const commands = [
  // Main ticket command with all subcommands
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket system commands')
    // Add user to ticket
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add a user to the ticket')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to add to the ticket')
            .setRequired(true)
        )
    )
    // Remove user from ticket
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove a user from the ticket')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to remove from the ticket')
            .setRequired(true)
        )
    )
    // Close ticket
    .addSubcommand(subcommand =>
      subcommand
        .setName('close')
        .setDescription('Close the current ticket')
    )
    // Delete ticket
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete')
        .setDescription('Permanently delete the ticket')
    )
    // Reopen ticket
    .addSubcommand(subcommand =>
      subcommand
        .setName('open')
        .setDescription('Reopen a closed ticket')
    )
    // Create panel
    .addSubcommand(subcommand =>
      subcommand
        .setName('panel')
        .setDescription('Create a ticket panel')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Name of the panel')
            .setRequired(true)
        )
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel to send the panel to')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('title')
            .setDescription('Panel title')
            .setRequired(false)
        )
        .addStringOption(option =>
          option.setName('description')
            .setDescription('Panel description')
            .setRequired(false)
        )
        .addStringOption(option =>
          option.setName('image-url')
            .setDescription('Panel image URL')
            .setRequired(false)
        )
    )
    // Setup system
    .addSubcommand(subcommand =>
      subcommand
        .setName('setup')
        .setDescription('Set up the ticket system')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('Support role for tickets')
            .setRequired(true)
        )
        .addChannelOption(option =>
          option.setName('category')
            .setDescription('Category for closed tickets')
            .setRequired(true)
        )
        .addChannelOption(option =>
          option.setName('log-channel')
            .setDescription('Channel for ticket logs')
            .setRequired(false)
        )
        .addStringOption(option =>
          option.setName('color')
            .setDescription('Default panel color (hex code)')
            .setRequired(false)
        )
    )
    // Generate transcript
    .addSubcommand(subcommand =>
      subcommand
        .setName('transcript')
        .setDescription('Generate a transcript of the ticket')
    )
].map(command => command.toJSON());

// Register commands with Discord
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );
    console.log('Successfully registered slash commands!');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
})();

// Helper functions
async function createTicketChannel(guild, user, panelName) {
  const config = db.prepare('SELECT * FROM config WHERE guildId = ?').get(guild.id);
  if (!config?.supportRole) {
    throw new Error('Ticket system not set up!');
  }

  const ticketName = `ticket-${user.username.toLowerCase()}`;
  const existingTicket = guild.channels.cache.find(
    c => c.name === ticketName && c.type === ChannelType.GuildText
  );

  if (existingTicket) {
    throw new Error(`You already have an open ticket: ${existingTicket}`);
  }

  const channel = await guild.channels.create({
    name: ticketName,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: config.supportRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ],
  });

  // Save to database
  db.prepare(`
    INSERT INTO tickets (channelId, guildId, ownerId, panelName)
    VALUES (?, ?, ?, ?)
  `).run(channel.id, guild.id, user.id, panelName);

  db.prepare(`
    INSERT INTO ticket_members (channelId, userId)
    VALUES (?, ?)
  `).run(channel.id, user.id);

  return channel;
}

async function generateTranscript(channel) {
  return await createTranscript(channel, {
    limit: -1,
    returnType: 'buffer',
    filename: `${channel.name}-transcript.html`,
    saveImages: true
  });
}

// Event handlers
client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) {
    // Handle button clicks for ticket creation
    if (interaction.isButton() && interaction.customId.startsWith('ticket_')) {
      const panelName = interaction.customId.replace('ticket_', '');
      try {
        await interaction.deferReply({ ephemeral: true });
        const channel = await createTicketChannel(interaction.guild, interaction.user, panelName);
        
        const panel = db.prepare('SELECT * FROM panels WHERE guildId = ? AND panelName = ?').get(interaction.guild.id, panelName);
        const config = db.prepare('SELECT * FROM config WHERE guildId = ?').get(interaction.guild.id);
        
        const embed = new EmbedBuilder()
          .setColor(config?.panelColor || '#FFC0CB')
          .setTitle(panel?.title || 'Support Ticket')
          .setDescription(panel?.description || `Hello ${interaction.user}, support will be with you shortly!`)
          .setFooter({ text: `Ticket ID: ${channel.id}` });
        
        await channel.send({ 
          content: `${interaction.user} <@&${config.supportRole}>`, 
          embeds: [embed] 
        });
        
        await interaction.editReply({ 
          content: `Your ticket has been created: ${channel}`, 
          ephemeral: true 
        });
      } catch (error) {
        console.error('Error creating ticket:', error);
        await interaction.editReply({ 
          content: `❌ Error: ${error.message}`, 
          ephemeral: true 
        });
      }
    }
    return;
  }

  // Handle slash commands
  try {
    await handleSlashCommand(interaction);
  } catch (error) {
    console.error('Error handling command:', error);
    if (!interaction.replied) {
      await interaction.reply({ 
        content: `❌ Error: ${error.message}`, 
        ephemeral: true 
      });
    }
  }
});

async function handleSlashCommand(interaction) {
  const { options, channel, guild, member, user } = interaction;
  const subcommand = options.getSubcommand();
  
  // Check permissions for admin commands
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
  const config = db.prepare('SELECT * FROM config WHERE guildId = ?').get(guild.id);
  const isStaff = config?.supportRole && member.roles.cache.has(config.supportRole);

  switch (subcommand) {
    case 'setup':
      if (!isAdmin) throw new Error('You need administrator permissions!');
      
      const supportRole = options.getRole('role');
      const closedCategory = options.getChannel('category');
      const logChannel = options.getChannel('log-channel');
      const color = options.getString('color') || '#FFC0CB';
      
      db.prepare(`
        INSERT OR REPLACE INTO config (guildId, supportRole, closedCategory, logChannel, panelColor)
        VALUES (?, ?, ?, ?, ?)
      `).run(guild.id, supportRole.id, closedCategory.id, logChannel?.id, color);
      
      await interaction.reply({
        content: `✅ Ticket system configured!\n`
          + `• Support Role: ${supportRole}\n`
          + `• Closed Tickets: ${closedCategory}\n`
          + `• Log Channel: ${logChannel || 'Not set'}\n`
          + `• Panel Color: ${color}`,
        ephemeral: true
      });
      break;

    case 'panel':
      if (!isAdmin) throw new Error('You need administrator permissions!');
      
      const panelName = options.getString('name');
      const panelChannel = options.getChannel('channel');
      const title = options.getString('title') || 'Support Tickets';
      const description = options.getString('description') || 'Click the button below to create a new ticket!';
      const imageUrl = options.getString('image-url');
      
      // Save panel to database
      db.prepare(`
        INSERT OR REPLACE INTO panels (guildId, panelName, channelId, title, description, imageUrl)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(guild.id, panelName, panelChannel.id, title, description, imageUrl);
      
      // Create panel embed
      const panelEmbed = new EmbedBuilder()
        .setColor(config?.panelColor || '#FFC0CB')
        .setTitle(title)
        .setDescription(description);
        
      if (imageUrl) panelEmbed.setImage(imageUrl);
      
      const ticketButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket_${panelName}`)
          .setLabel('Create Ticket')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🎫')
      );
      
      await panelChannel.send({ embeds: [panelEmbed], components: [ticketButton] });
      await interaction.reply({ 
        content: `✅ Created ${panelName} ticket panel in ${panelChannel}!`, 
        ephemeral: true 
      });
      break;

    case 'add':
      const userToAdd = options.getUser('user');
      const ticket = db.prepare('SELECT * FROM tickets WHERE channelId = ?').get(channel.id);
      
      if (!ticket && !isStaff) throw new Error('This is not a ticket channel!');
      if (!isStaff && ticket.ownerId !== user.id) throw new Error('Only ticket owners or staff can add users!');
      
      await channel.permissionOverwrites.edit(userToAdd.id, {
        ViewChannel: true,
        SendMessages: true
      });
      
      db.prepare(`
        INSERT OR IGNORE INTO ticket_members (channelId, userId)
        VALUES (?, ?)
      `).run(channel.id, userToAdd.id);
      
      await interaction.reply({ 
        content: `✅ Added ${userToAdd} to the ticket!`, 
        ephemeral: false 
      });
      break;

    case 'remove':
      const userToRemove = options.getUser('user');
      const ticketData = db.prepare('SELECT * FROM tickets WHERE channelId = ?').get(channel.id);
      
      if (!ticketData && !isStaff) throw new Error('This is not a ticket channel!');
      if (!isStaff && ticketData.ownerId !== user.id) throw new Error('Only ticket owners or staff can remove users!');
      if (userToRemove.id === ticketData.ownerId) throw new Error('Cannot remove the ticket owner!');
      
      await channel.permissionOverwrites.delete(userToRemove.id);
      
      db.prepare(`
        DELETE FROM ticket_members WHERE channelId = ? AND userId = ?
      `).run(channel.id, userToRemove.id);
      
      await interaction.reply({ 
        content: `✅ Removed ${userToRemove} from the ticket!`, 
        ephemeral: false 
      });
      break;

    case 'close':
      const ticketToClose = db.prepare('SELECT * FROM tickets WHERE channelId = ?').get(channel.id);
      if (!ticketToClose) throw new Error('This is not a ticket channel!');
      if (!isStaff && ticketToClose.ownerId !== user.id) throw new Error('Only ticket owners or staff can close tickets!');
      
      // Generate transcript
      await interaction.deferReply();
      const transcript = await generateTranscript(channel);
      
      // Update database
      db.prepare(`
        UPDATE tickets SET status = 'closed', closedAt = strftime('%s', 'now') 
        WHERE channelId = ?
      `).run(channel.id);
      
      // Move to closed category
      if (config?.closedCategory) {
        await channel.setParent(config.closedCategory);
      }
      
      // Remove all members except staff
      const members = db.prepare('SELECT userId FROM ticket_members WHERE channelId = ?').all(channel.id);
      for (const { userId } of members) {
        if (userId !== ticketToClose.ownerId && !(isStaff && userId === user.id)) {
          await channel.permissionOverwrites.delete(userId);
        }
      }
      
      // Send transcript to log channel
      if (config?.logChannel) {
        const logChannel = guild.channels.cache.get(config.logChannel);
        if (logChannel) {
          await logChannel.send({
            content: `📝 Transcript for ticket ${channel.name} (Closed by ${user.tag})`,
            files: [{
              attachment: transcript,
              name: `${channel.name}-transcript.html`
            }]
          });
        }
      }
      
      await interaction.editReply({ 
        content: '✅ Ticket closed! The transcript has been saved.' 
      });
      break;

    case 'open':
      const closedTicket = db.prepare(`SELECT * FROM tickets WHERE channelId = ? AND status = 'closed'`).get(channel.id);
      if (!closedTicket) throw new Error('This is not a closed ticket!');
      if (!isStaff) throw new Error('Only staff can reopen tickets!');
      
      // Re-add original members
      const originalMembers = db.prepare('SELECT userId FROM ticket_members WHERE channelId = ?').all(channel.id);
      for (const { userId } of originalMembers) {
        await channel.permissionOverwrites.edit(userId, {
          ViewChannel: true,
          SendMessages: true
        });
      }
      
      // Update status
      db.prepare('UPDATE tickets SET status = 'open' WHERE channelId = ?').run(channel.id);
      
      await interaction.reply({ 
        content: '✅ Ticket reopened! All original members have been readded.', 
        ephemeral: false 
      });
      break;

    case 'delete':
      const ticketToDelete = db.prepare('SELECT * FROM tickets WHERE channelId = ?').get(channel.id);
      if (!ticketToDelete) throw new Error('This is not a ticket channel!');
      if (!isStaff) throw new Error('Only staff can delete tickets!');
      
      // Generate transcript before deleting
      await interaction.deferReply({ ephemeral: true });
      const deleteTranscript = await generateTranscript(channel);
      
      // Save transcript to log channel
      if (config?.logChannel) {
        const logChannel = guild.channels.cache.get(config.logChannel);
        if (logChannel) {
          await logChannel.send({
            content: `🗑️ Transcript for DELETED ticket ${channel.name} (Deleted by ${user.tag})`,
            files: [{
              attachment: deleteTranscript,
              name: `${channel.name}-transcript.html`
            }]
          });
        }
      }
      
      // Clean up database
      db.prepare('DELETE FROM tickets WHERE channelId = ?').run(channel.id);
      db.prepare('DELETE FROM ticket_members WHERE channelId = ?').run(channel.id);
      
      // Delete channel
      await channel.delete('Ticket deleted by staff');
      await interaction.editReply({ 
        content: '✅ Ticket deleted! The transcript has been saved.', 
        ephemeral: true 
      });
      break;

    case 'transcript':
      const ticketForTranscript = db.prepare('SELECT * FROM tickets WHERE channelId = ?').get(channel.id);
      if (!ticketForTranscript) throw new Error('This is not a ticket channel!');
      if (!isStaff && ticketForTranscript.ownerId !== user.id) throw new Error('Only ticket owners or staff can generate transcripts!');
      
      await interaction.deferReply({ ephemeral: true });
      const transcriptFile = await generateTranscript(channel);
      
      await interaction.editReply({
        content: 'Here is the transcript of this ticket:',
        files: [{
          attachment: transcriptFile,
          name: `${channel.name}-transcript.html`
        }],
        ephemeral: true
      });
      break;

    default:
      throw new Error('Unknown subcommand!');
  }
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);

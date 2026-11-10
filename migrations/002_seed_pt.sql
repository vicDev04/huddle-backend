-- Portuguese (pt-PT) content. Idempotent: deactivates old global rows, inserts missing PT rows, reactivates existing PT rows.

create temp table _pt_hive(text varchar(140)) on commit drop;

insert into _pt_hive(text) values
('Quem é mais capaz de ganhar fama por uma coisa completamente ridícula?'),
('Quem sobrevivia mais tempo num apocalipse zombie?'),
('Quem é mais capaz de responder a uma mensagem três dias depois?'),
('Quem tem menos jeito para guardar o segredo de uma festa surpresa?'),
('Quem é mais capaz de se perder mesmo com o GPS ligado?'),
('Quem ganhava um concurso de culinária só com comida de bomba de gasolina?'),
('Quem é mais capaz de adotar cinco gatos num só ano?'),
('Quem é a primeira pessoa a chorar num filme triste?'),
('Quem é mais capaz de criar um negócio que resulta mesmo?'),
('Quem é mais capaz de se atrasar para o próprio casamento?'),
('Quem fazia o melhor papel de vilão num reality show?'),
('Quem é mais capaz de adormecer a meio de uma festa?'),
('Quem gasta mais dinheiro em coisas que nunca usa?'),
('Quem é mais capaz de se livrar de uma multa só com conversa?'),
('Quem querias na tua equipa numa escape room?'),
('Quem é mais capaz de ter um talento secreto que ninguém conhece?'),
('Quem aguentava mais tempo sem telemóvel?'),
('Quem é mais capaz de se mudar para outro país sem pensar duas vezes?'),
('Quem dá os melhores conselhos mas nunca os segue?'),
('Quem é mais capaz de se rir no pior momento possível?'),
('Quem vai contar as melhores histórias aos netos?'),
('Quem é mais capaz de fazer uma tatuagem de que se vai arrepender?'),
('Quem é mais capaz de se esquecer do próprio aniversário?'),
('Quem faz de psicólogo não oficial do grupo?'),
('Quem fazia o melhor bluff no póquer?'),
('Quem é mais capaz de se tornar viral com uma dança horrível?'),
('Quem era eliminado primeiro num reality show de sobrevivência?'),
('Quem é mais capaz de ter sapatos a mais?'),
('Quem ganhava uma batalha de karaoke?'),
('Quem é mais capaz de mandar uma mensagem embaraçosa à pessoa errada?'),
('Quem planeava as férias mais caóticas de sempre?'),
('Quem é mais capaz de ganhar o Euromilhões e perder o boletim?'),
('Quem faz mais drama quando apanha uma constipação?'),
('Quem é mais capaz de fazer amizade com um desconhecido na fila do supermercado?'),
('Quem tinha mais jeito para espião?'),
('Quem é mais capaz de dizer "só mais um episódio" às 4 da manhã?'),
('Quem deixava a casa mais desarrumada se vivêssemos todos juntos?'),
('Quem é mais capaz de trazer snacks para toda a gente?'),
('Quem durava mais tempo numa ilha deserta?'),
('Quem é mais capaz de começar uma guerra no grupo por causa de pizza com ananás?'),
('Quem devia ser presidente deste grupo?'),
('Quem é mais capaz de virar meme?'),
('Quem se oferecia primeiro para uma viagem a Marte?'),
('Quem é mais capaz de devolver uma coisa à loja um ano depois?'),
('Quem tem a galeria de fotos mais caótica?'),
('Quem é mais capaz de comer uma francesinha inteira e ainda pedir sobremesa?'),
('Quem é mais capaz de dizer "estou a sair de casa" e aparecer meia hora depois?'),
('Quem é mais capaz de discutir com o árbitro através da televisão?'),
('Quem é mais capaz de se perder no IKEA?'),
('Quem é mais capaz de levar o tupperware da mãe e nunca o devolver?');

create temp table _pt_hot(text varchar(140)) on commit drop;

insert into _pt_hot(text) values
('O que faria {name} com um milhão de euros até amanhã?'),
('Descreve {name} usando só o título de um filme.'),
('Qual seria a história de origem de {name} como super-vilão?'),
('Se {name} viesse com um rótulo de aviso, o que dizia?'),
('Qual seria o título da autobiografia de {name}?'),
('Qual é a pesquisa no Google mais provável de {name} às 3 da manhã?'),
('Em que profissão é que {name} seria secretamente incrível?'),
('Se {name} fosse um ingrediente de pizza, qual era e porquê?'),
('O que levaria {name} para uma ilha deserta?'),
('Como se chamaria o talk show de {name}?'),
('Qual é o superpoder de {name}, e o efeito secundário irritante?'),
('Que nome daria {name} ao seu barco?'),
('Que música toca quando {name} entra numa sala?'),
('Porque é que {name} vai aparecer nas notícias daqui a 10 anos?'),
('O que diria a bio de {name} numa app de encontros?'),
('Qual seria a primeira medida de {name} como presidente da câmara?'),
('Qual é o passo de dança infalível de {name} numa festa?'),
('Inventa uma alcunha nova para {name}.'),
('Do que é que {name} se ia queixar no céu?'),
('Qual é a única coisa a que {name} nunca consegue dizer que não?');

update hive_questions set is_active = (text in (select text from _pt_hive)) where group_id is null;

update hot_seat_prompts set is_active = (text in (select text from _pt_hot));

insert into hive_questions(text, is_active) select p.text, true from _pt_hive p where not exists (select 1 from hive_questions h where h.group_id is null and h.text = p.text);

insert into hot_seat_prompts(text, is_active) select p.text, true from _pt_hot p where not exists (select 1 from hot_seat_prompts h where h.text = p.text);
